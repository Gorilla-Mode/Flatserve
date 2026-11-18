package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/bits"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type config struct {
	base              string
	duration, timeout time.Duration
	rates             []int
	concurrency       int
	yes               bool
}

func parseConfig(args []string, out io.Writer) (config, error) {
	f := flag.NewFlagSet("loadgen", flag.ContinueOnError)
	f.SetOutput(out)
	base := f.String("base-url", "http://localhost:5220", "API base URL")
	duration := f.Float64("duration", 0, "seconds per stage (required, at least one Vestland route loop)")
	rps := f.Int("rps", 0, "starting requests per second (required)")
	maximum := f.Int("max-rps", 0, "final ramp rate (requires --step-rps)")
	step := f.Int("step-rps", 0, "ramp rate increment (requires --max-rps)")
	concurrency := f.Int("concurrency", 1024, "maximum concurrent requests")
	timeout := f.Float64("timeout", 10, "request timeout in seconds")
	yes := f.Bool("yes", false, "skip confirmation")
	if err := f.Parse(args); err != nil {
		return config{}, err
	}
	validSeconds := func(v float64) bool {
		return v > 0 && !math.IsNaN(v) && !math.IsInf(v, 0) && v < float64(math.MaxInt64)/1e9 && time.Duration(v*1e9) > 0
	}
	if f.NArg() != 0 || !validSeconds(*duration) || !validSeconds(*timeout) || *rps <= 0 || *concurrency <= 0 {
		return config{}, errors.New("positive --duration and integer --rps are required; timeout and concurrency must also be positive")
	}
	u, err := url.Parse(*base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return config{}, errors.New("base-url must be an HTTP(S) URL without a query or fragment")
	}
	rates, err := stageRates(*rps, *maximum, *step)
	if err != nil {
		return config{}, err
	}
	c := config{strings.TrimRight(*base, "/"), time.Duration(math.Round(*duration * 1e9)), time.Duration(*timeout * 1e9), rates, *concurrency, *yes}
	minimum := minimumStageDuration(rates[0])
	if c.duration < minimum {
		return config{}, fmt.Errorf("--duration must be at least %.9f seconds at %d RPS to schedule a complete %d-request Vestland route", minimum.Seconds(), rates[0], routeSlots)
	}
	var total int64
	for _, rate := range rates {
		n := requestSlots(c.duration, rate, false)
		if n >= math.MaxInt64-total {
			return config{}, errors.New("planned request count must fit in int64")
		}
		total += n
	}
	return c, nil
}

func minimumStageDuration(rate int) time.Duration {
	// Round up to the first whole nanosecond that can fit a complete loop.
	return 1 + (routeSlots*time.Second-1)/time.Duration(rate)
}

func stageRates(start, maximum, step int) ([]int, error) {
	if maximum == 0 && step == 0 {
		return []int{start}, nil
	}
	if maximum < start || step <= 0 {
		return nil, errors.New("ramp requires --max-rps >= --rps and --step-rps > 0")
	}
	rates := []int{start}
	for rate := start; rate < maximum; {
		next := maximum
		if step < maximum-rate {
			next = rate + step
		}
		rates = append(rates, next)
		rate = next
	}
	return rates, nil
}

const (
	stepsPerLeg = 100
	routeSlots  = 3*stepsPerLeg + 1
)

type bbox struct {
	minLon, minLat, maxLon, maxLat float64
}

type view struct {
	lon, lat, halfWidth, halfHeight float64
}

func (v view) bounds() bbox {
	return bbox{
		v.lon - v.halfWidth, v.lat - v.halfHeight,
		v.lon + v.halfWidth, v.lat + v.halfHeight,
	}
}

func (v view) interpolate(next view, progress float64) view {
	return view{
		lon:        v.lon + (next.lon-v.lon)*progress,
		lat:        v.lat + (next.lat-v.lat)*progress,
		halfWidth:  v.halfWidth * math.Pow(next.halfWidth/v.halfWidth, progress),
		halfHeight: v.halfHeight * math.Pow(next.halfHeight/v.halfHeight, progress),
	}
}

var vestlandRoute = buildVestlandRoute()

func routeBounds(slot int64) bbox {
	return vestlandRoute[slot%routeSlots]
}

func buildVestlandRoute() [routeSlots]bbox {
	const (
		bergenLon       = 5.324
		bergenLat       = 60.393
		breivikenLat    = 60.420
		floroLon        = 5.0328
		floroLat        = 61.5996
		blockHalfHeight = 0.1 / 111.32 // 100 meters in degrees of latitude.
	)
	latitudeScale := math.Cos(bergenLat * math.Pi / 180)
	breivikenHalfHeight := breivikenLat - bergenLat
	breivikenHalfWidth := breivikenHalfHeight / latitudeScale

	// Vestland (county 46) WGS84 extent from Kartverket, rounded outward.
	// https://ws.geonorge.no/kommuneinfo/v1/fylker/46/omrade
	county := bbox{4.087524, 59.475420, 8.322053, 62.382397}
	roundUp := func(degrees float64) float64 { return math.Ceil(degrees*100) / 100 }
	fullHalfWidth := roundUp(max(bergenLon-county.minLon, county.maxLon-bergenLon))
	fullHalfHeight := roundUp(max(bergenLat-county.minLat, county.maxLat-bergenLat))
	waypoints := [...]view{
		{bergenLon, bergenLat, blockHalfHeight / latitudeScale, blockHalfHeight},
		{bergenLon, bergenLat, breivikenHalfWidth, breivikenHalfHeight},
		{floroLon, floroLat - breivikenHalfHeight, breivikenHalfWidth, breivikenHalfHeight},
		{bergenLon, bergenLat, fullHalfWidth, fullHalfHeight},
	}
	var route [routeSlots]bbox
	for leg, start := range waypoints[:len(waypoints)-1] {
		for step := 0; step < stepsPerLeg; step++ {
			progress := float64(step) / stepsPerLeg
			route[leg*stepsPerLeg+step] = start.interpolate(waypoints[leg+1], progress).bounds()
		}
	}
	route[routeSlots-1] = waypoints[len(waypoints)-1].bounds()
	return route
}

// Compute duration * rate / 1s with integer arithmetic so a complete loop
// at the minimum duration never loses a slot to floating point rounding.
func requestSlots(duration time.Duration, rate int, roundUp bool) int64 {
	hi, lo := bits.Mul64(uint64(duration), uint64(rate))
	if hi >= uint64(time.Second) {
		return math.MaxInt64
	}
	slots, remainder := bits.Div64(hi, lo, uint64(time.Second))
	if slots >= math.MaxInt64 {
		return math.MaxInt64
	}
	if roundUp && remainder != 0 {
		slots++
	}
	return int64(slots)
}

// Bounded ~1% logarithmic buckets in microseconds; zero/sub-microsecond samples use bucket 0.
type histogram struct {
	buckets [4096]int64
	count   int64
	maximum time.Duration
}

func (h *histogram) add(d time.Duration) {
	index := 0
	if us := float64(d) / float64(time.Microsecond); us > 1 {
		index = int(math.Ceil(math.Log(us) / math.Log(1.01)))
	}
	if index >= len(h.buckets) {
		index = len(h.buckets) - 1
	}
	h.buckets[index]++
	h.count++
	if d > h.maximum {
		h.maximum = d
	}
}
func (h *histogram) percentile(p float64) time.Duration {
	if h.count == 0 {
		return 0
	}
	target, cumulative := int64(math.Ceil(p*float64(h.count))), int64(0)
	for i, n := range h.buckets {
		cumulative += n
		if cumulative >= target {
			estimate := math.Pow(1.01, float64(i)) * float64(time.Microsecond)
			if estimate >= float64(h.maximum) {
				return h.maximum
			}
			return time.Duration(estimate)
		}
	}
	return h.maximum
}

type result struct {
	planned, started, completed, success, httpFailures, timeouts, transportErrors, canceled int64
	lateDrops, capacityDrops                                                                int64
	scheduling, elapsed                                                                     time.Duration
	latency                                                                                 histogram
	statuses                                                                                map[int]int64
}
type counters struct {
	sync.Mutex
	result
}

func (s *counters) snapshot() result { s.Lock(); defer s.Unlock(); return s.result }

func newClient(c config) *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxConnsPerHost = c.concurrency
	t.MaxIdleConnsPerHost = c.concurrency
	t.MaxIdleConns = c.concurrency
	return &http.Client{Transport: t, Timeout: c.timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func request(ctx context.Context, client *http.Client, base string, bounds bbox, s *counters) {
	s.Lock()
	s.started++
	s.Unlock()
	start := time.Now()
	address := fmt.Sprintf("%s/fgb/collection?userId=2&minX=%.8f&minY=%.8f&maxX=%.8f&maxY=%.8f",
		base, bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	status := 0
	if err == nil {
		req.Header.Set("Accept", "multipart/mixed")
		var response *http.Response
		response, err = client.Do(req)
		if response != nil {
			status = response.StatusCode
			_, readErr := io.Copy(io.Discard, response.Body)
			closeErr := response.Body.Close()
			if err == nil {
				err = readErr
			}
			if err == nil {
				err = closeErr
			}
		}
	}
	s.Lock()
	defer s.Unlock()
	s.completed++
	s.latency.add(time.Since(start))
	if status != 0 {
		s.statuses[status]++
	}
	var netError net.Error
	switch {
	case ctx.Err() != nil:
		s.canceled++
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netError) && netError.Timeout()):
		s.timeouts++
	case err != nil:
		s.transportErrors++
	case status >= 200 && status < 300:
		s.success++
	default:
		s.httpFailures++
	}
}

// Account for a millisecond's slots together, with no unlimited catch-up after delays.
func batch(elapsed, duration time.Duration, rate int, total, accounted int64) (int64, int64, int64) {
	if elapsed >= duration {
		return total, 0, total - accounted
	}
	horizon := elapsed + min(time.Millisecond, duration-elapsed)
	due := min(total, requestSlots(horizon, rate, true))
	n := max(int64(0), due-accounted)
	allowance := requestSlots(time.Millisecond, rate, true)
	return due, min(n, allowance), max(int64(0), n-allowance)
}

func dispatch(jobs chan<- bbox, slots chan<- struct{}, first, end int64) (dropped int64) {
	for slot := first; slot < end; slot++ {
		select {
		case slots <- struct{}{}:
			jobs <- routeBounds(slot)
		default:
			dropped++
		}
	}
	return dropped
}

func runStage(ctx context.Context, c config, rate int, client *http.Client, out io.Writer) result {
	planned := requestSlots(c.duration, rate, false)
	s := &counters{result: result{planned: planned, statuses: make(map[int]int64)}}
	jobs := make(chan bbox, c.concurrency)
	slots := make(chan struct{}, c.concurrency)
	var workers sync.WaitGroup
	for i := 0; i < c.concurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for bounds := range jobs {
				request(ctx, client, c.base, bounds, s)
				<-slots
			}
		}()
	}
	progressTable := newTable(out, []string{"Elapsed", "Target RPS", "Start RPS", "Completed", "Failures", "Late drops", "Capacity drops"}, len(strconv.FormatInt(s.planned, 10)))
	start := time.Now()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	progress := time.NewTicker(time.Second)
	defer progress.Stop()
	accounted := int64(0)
loop:
	for {
		if ctx.Err() != nil {
			break
		}
		now := time.Since(start)
		var sends, late int64
		accounted, sends, late = batch(now, c.duration, rate, planned, accounted)
		// The oldest overdue slots are dropped. Remaining jobs keep their
		// scheduled positions even when the concurrency limit drops more.
		capacityDrops := dispatch(jobs, slots, accounted-sends, accounted)
		s.Lock()
		s.lateDrops += late
		s.capacityDrops += capacityDrops
		s.Unlock()
		if now >= c.duration {
			break
		}
		select {
		case <-ctx.Done():
			break loop
		case <-ticker.C:
		case <-progress.C:
			r := s.snapshot()
			printProgress(progressTable, rate, r, time.Since(start))
		}
	}
	scheduling := time.Since(start)
	close(jobs)
	workers.Wait()
	r := s.snapshot()
	r.scheduling = scheduling
	r.elapsed = time.Since(start)
	printProgress(progressTable, rate, r, scheduling)
	progressTable.border()
	return r
}

// Fixed widths keep live rows aligned without buffering output or terminal escapes.
type outputTable struct {
	out    io.Writer
	widths []int
}

func newTable(out io.Writer, headers []string, minWidth int) *outputTable {
	t := &outputTable{out: out, widths: make([]int, len(headers))}
	for i, h := range headers {
		t.widths[i] = max(len(h), minWidth)
	}
	t.border()
	t.row(headers...)
	t.border()
	return t
}

func (t *outputTable) border() {
	for _, width := range t.widths {
		fmt.Fprint(t.out, "+", strings.Repeat("-", width+2))
	}
	fmt.Fprintln(t.out, "+")
}

func (t *outputTable) row(values ...string) {
	for i, value := range values {
		fmt.Fprintf(t.out, "| %*s ", t.widths[i], value)
	}
	fmt.Fprintln(t.out, "|")
}

func printTable(out io.Writer, headers []string, rows [][]string) {
	widths := make([]int, len(headers))
	for i, header := range headers {
		widths[i] = len(header)
	}
	for _, row := range rows {
		for i, cell := range row {
			widths[i] = max(widths[i], len(cell))
		}
	}
	t := &outputTable{out: out, widths: widths}
	t.border()
	t.row(headers...)
	t.border()
	for _, row := range rows {
		t.row(row...)
	}
	t.border()
}

func number(n int64) string { return strconv.FormatInt(n, 10) }

func printProgress(t *outputTable, rate int, r result, elapsed time.Duration) {
	t.row(fmt.Sprintf("%.1fs", elapsed.Seconds()), strconv.Itoa(rate),
		fmt.Sprintf("%.0f", float64(r.started)/elapsed.Seconds()), number(r.completed),
		number(r.completed-r.success), number(r.lateDrops), number(r.capacityDrops))
}

func printResult(out io.Writer, rate int, r result) {
	fmt.Fprintf(out, "\nStage results (%d target RPS)\n", rate)
	printTable(out, []string{"Requests", "Count"}, [][]string{
		{"Planned", number(r.planned)}, {"Started", number(r.started)}, {"Completed", number(r.completed)},
		{"Successful", number(r.success)}, {"HTTP failures", number(r.httpFailures)},
		{"Timeouts", number(r.timeouts)}, {"Other errors", number(r.transportErrors)},
		{"Canceled", number(r.canceled)}, {"Late drops", number(r.lateDrops)}, {"Capacity drops", number(r.capacityDrops)},
	})
	printTable(out, []string{"Timing", "Value"}, [][]string{
		{"Scheduling", fmt.Sprintf("%.3f s", r.scheduling.Seconds())},
		{"Drain", fmt.Sprintf("%.3f s", (r.elapsed - r.scheduling).Seconds())},
		{"Latency p50 (approx.)", fmt.Sprintf("%.3f ms", float64(r.latency.percentile(.5))/1e6)},
		{"Latency p95 (approx.)", fmt.Sprintf("%.3f ms", float64(r.latency.percentile(.95))/1e6)},
		{"Latency p99 (approx.)", fmt.Sprintf("%.3f ms", float64(r.latency.percentile(.99))/1e6)},
		{"Latency max", fmt.Sprintf("%.3f ms", float64(r.latency.maximum)/1e6)},
	})
	printStatuses(out, r.statuses)
}

func printStatuses(out io.Writer, statuses map[int]int64) {
	codes := make([]int, 0, len(statuses))
	for code := range statuses {
		codes = append(codes, code)
	}
	sort.Ints(codes)
	rows := make([][]string, 0, len(codes))
	for _, code := range codes {
		rows = append(rows, []string{strconv.Itoa(code), number(statuses[code])})
	}
	if len(rows) == 0 {
		rows = append(rows, []string{"None", "0"})
	}
	printTable(out, []string{"HTTP status", "Count"}, rows)
}

func execute(ctx context.Context, args []string, in io.Reader, out io.Writer) int {
	c, err := parseConfig(args, out)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintln(out, err)
		return 2
	}
	var planned int64
	for i, rate := range c.rates {
		n := requestSlots(c.duration, rate, false)
		planned += n
		fmt.Fprintf(out, "Stage %d: %d RPS for %gs (%d planned)\n", i+1, rate, c.duration.Seconds(), n)
	}
	fmt.Fprintf(out, "Endpoint: %s/fgb/collection (user 2)\n", c.base)
	fmt.Fprintf(out, "Route: Bergen block → Breiviken → Florø → Bergen with all of Vestland in view (%d requests per loop)\n", routeSlots)
	fmt.Fprintf(out, "Minimum stage duration: %.9f s at %d RPS\n", minimumStageDuration(c.rates[0]).Seconds(), c.rates[0])
	fmt.Fprintln(out, "For a full-file response at the final waypoint, use a Vestland-only dataset accessible to user 2.")
	fmt.Fprintf(out, "Total scheduling: %gs; planned: %d; concurrency: %d; timeout: %gs\n", c.duration.Seconds()*float64(len(c.rates)), planned, c.concurrency, c.timeout.Seconds())
	if !c.yes {
		fmt.Fprint(out, "Start? [y/N] ")
		confirmation := make(chan string, 1)
		go func() {
			answer, _ := bufio.NewReader(in).ReadString('\n')
			confirmation <- answer
		}()
		var answer string
		select {
		case <-ctx.Done():
			fmt.Fprintln(out, "Cancelled; no requests sent.")
			return 130
		case answer = <-confirmation:
		}
		answer = strings.ToLower(strings.TrimSpace(answer))
		if answer != "y" && answer != "yes" {
			fmt.Fprintln(out, "Cancelled; no requests sent.")
			return 0
		}
	}
	client := newClient(c)
	defer client.CloseIdleConnections()
	overall := result{planned: planned, statuses: make(map[int]int64)}
	started := time.Now()
	for _, rate := range c.rates {
		if ctx.Err() != nil {
			break
		}
		fmt.Fprintf(out, "\nRunning stage: %d target RPS\n", rate)
		r := runStage(ctx, c, rate, client, out)
		printResult(out, rate, r)
		overall.started += r.started
		overall.completed += r.completed
		overall.success += r.success
		overall.lateDrops += r.lateDrops
		overall.capacityDrops += r.capacityDrops
		for code, n := range r.statuses {
			overall.statuses[code] += n
		}
	}
	fmt.Fprintln(out, "\nOverall results")
	printTable(out, []string{"Metric", "Value"}, [][]string{
		{"Planned", number(overall.planned)}, {"Started", number(overall.started)},
		{"Completed", number(overall.completed)}, {"Successful", number(overall.success)},
		{"Failures", number(overall.completed - overall.success)}, {"Late drops", number(overall.lateDrops)},
		{"Capacity drops", number(overall.capacityDrops)}, {"Elapsed", fmt.Sprintf("%.3f s", time.Since(started).Seconds())},
	})
	printStatuses(out, overall.statuses)
	if ctx.Err() != nil {
		return 130
	}
	if overall.completed != overall.success || overall.lateDrops+overall.capacityDrops > 0 {
		return 1
	}
	return 0
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	os.Exit(execute(ctx, os.Args[1:], os.Stdin, os.Stdout))
}
