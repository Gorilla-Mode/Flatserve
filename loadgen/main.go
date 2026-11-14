package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
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
	duration := f.Float64("duration", 0, "seconds per stage (required)")
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
	c := config{strings.TrimRight(*base, "/"), time.Duration(*duration * 1e9), time.Duration(*timeout * 1e9), rates, *concurrency, *yes}
	var total int64
	for _, rate := range rates {
		n := math.Floor(c.duration.Seconds() * float64(rate))
		if n < 1 || n >= float64(math.MaxInt64-total) {
			return config{}, errors.New("planned request count must be at least one per stage and fit in int64")
		}
		total += int64(n)
	}
	return c, nil
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

var anchors = [][2]float64{{7.99, 58.15}, {5.73, 58.97}, {10.75, 59.91}, {5.32, 60.39}, {10.47, 61.12}, {7.16, 62.74}, {10.40, 63.43}, {12.15, 65.84}, {14.40, 67.28}, {18.96, 69.65}, {23.27, 69.97}, {30.05, 69.73}}

func bbox(rng *rand.Rand) [4]float64 {
	a := anchors[rng.Intn(len(anchors))]
	h := 75.0 / 111.32
	lat := math.Max(57.5+h, math.Min(71.5-h, a[1]+(rng.Float64()*100-50)/111.32))
	km := 111.32 * math.Cos(lat*math.Pi/180)
	w := 75 / km
	lon := math.Max(4+w, math.Min(32-w, a[0]+(rng.Float64()*100-50)/km))
	return [4]float64{math.Max(4, lon-w), math.Max(57.5, lat-h), math.Min(32, lon+w), math.Min(71.5, lat+h)}
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

func request(ctx context.Context, client *http.Client, base string, rng *rand.Rand, s *counters) {
	s.Lock()
	s.started++
	s.Unlock()
	start := time.Now()
	b := bbox(rng)
	address := fmt.Sprintf("%s/fgb/collection?userId=2&minX=%.8f&minY=%.8f&maxX=%.8f&maxY=%.8f", base, b[0], b[1], b[2], b[3])
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
func batch(elapsed, duration time.Duration, rate int, accounted int64) (int64, int64, int64) {
	total := int64(math.Floor(duration.Seconds() * float64(rate)))
	if elapsed >= duration {
		return total, 0, total - accounted
	}
	horizon := min(elapsed+time.Millisecond, duration)
	due := min(total, int64(math.Ceil(horizon.Seconds()*float64(rate))))
	n := max(int64(0), due-accounted)
	allowance := int64(math.Ceil(float64(rate) / 1000))
	return due, min(n, allowance), max(int64(0), n-allowance)
}

func runStage(ctx context.Context, c config, rate int, client *http.Client, out io.Writer) result {
	s := &counters{result: result{planned: int64(math.Floor(c.duration.Seconds() * float64(rate))), statuses: make(map[int]int64)}}
	jobs := make(chan struct{}, c.concurrency)
	slots := make(chan struct{}, c.concurrency)
	var workers sync.WaitGroup
	for i := 0; i < c.concurrency; i++ {
		workers.Add(1)
		go func(seed int64) {
			defer workers.Done()
			rng := rand.New(rand.NewSource(seed))
			for range jobs {
				request(ctx, client, c.base, rng, s)
				<-slots
			}
		}(time.Now().UnixNano() + int64(i))
	}
	start := time.Now()
	progressTable := newTable(out, []string{"Elapsed", "Target RPS", "Start RPS", "Completed", "Failures", "Late drops", "Capacity drops"}, len(strconv.FormatInt(s.planned, 10)))
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
		accounted, sends, late = batch(now, c.duration, rate, accounted)
		s.Lock()
		s.lateDrops += late
		s.Unlock()
		for i := int64(0); i < sends; i++ {
			select {
			case slots <- struct{}{}:
				jobs <- struct{}{}
			default:
				s.Lock()
				s.capacityDrops++
				s.Unlock()
			}
		}
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
		n := int64(math.Floor(c.duration.Seconds() * float64(rate)))
		planned += n
		fmt.Fprintf(out, "Stage %d: %d RPS for %gs (%d planned)\n", i+1, rate, c.duration.Seconds(), n)
	}
	fmt.Fprintf(out, "Endpoint: %s/fgb/collection; user 2; all datasets; random Norway boxes ~150 x 150 km\n", c.base)
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
