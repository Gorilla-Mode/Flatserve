import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TimingRecord } from './timings';

const duration = (ms: number) => `${ms.toFixed(1)} ms`;

export function RequestTimings({ records }: { records: TimingRecord[] }) {
  const [includeParsing, setIncludeParsing] = useState(false);
  const [selected, setSelected] = useState<TimingRecord | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const origin = useRef<SVGGElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(250);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(panel.current!);
    return () => observer.disconnect();
  }, []);

  const metric = includeParsing ? 'Request + parsing' : 'Request';
  const values = records.map((record) => includeParsing ? record.totalMs : record.requestMs);
  const maximum = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 3));
  const step = [1, 2, 5, 10].find((value) => value * magnitude >= maximum / 3)! * magnitude;
  const top = Math.ceil(maximum / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const tickLabel = (value: number) => new Intl.NumberFormat('en', {
    notation: 'compact', maximumFractionDigits: 2,
  }).format(value);
  const left = Math.max(36, ...ticks.map((tick) => tickLabel(tick).length * 7 + 10));
  const right = Math.max(left, width - 14);
  const points = values.map((value, i) => ({
    x: records.length === 1 ? (left + right) / 2 : left + i * (right - left) / (records.length - 1),
    y: 132 - value / top * 100,
  }));
  const angleLabels = records.length > 1 && (right - left) / (records.length - 1)
    < Math.max(...records.map((record) => String(record.id).length * 7)) + 6;
  // Keep adjacent targets separate when calls are tightly packed on a phone.
  const hitWidth = records.length > 1 ? Math.min(24, (right - left) / (records.length - 1)) : 24;

  return <figure className="request-timings">
    <figcaption>API requests</figcaption>
    <p className="timings-metric">{metric}</p>
    <div ref={panel} className="timings-chart">
      {records.length === 0 ? <p className="timings-empty">No completed requests yet</p>
        : <svg width="100%" height="198" aria-label={`${metric} in milliseconds, oldest to newest`} role="group">
          <text x="8" y="17" className="timings-axis">ms</text>
          {ticks.map((tick) => {
            const y = 132 - tick / top * 100;
            return <g key={tick} aria-hidden="true">
              <line x1={left} x2={right} y1={y} y2={y} className="timings-grid" />
              <text x={left - 6} y={y + 4} textAnchor="end" className="timings-axis">{tickLabel(tick)}</text>
            </g>;
          })}
          <polyline points={points.map(({ x, y }) => `${x},${y}`).join(' ')} className="timings-line" />
          <text x={(left + right) / 2} y="187" textAnchor="middle" className="timings-axis">Calls</text>
          {records.map((record, i) => <g key={record.id} aria-hidden="true" className="timings-call-tick">
            <line x1={points[i].x} x2={points[i].x} y1="132" y2="138" className="timings-grid" />
            <text x={points[i].x} y={angleLabels ? 145 : 153} textAnchor={angleLabels ? 'end' : 'middle'}
              transform={angleLabels ? `rotate(-60 ${points[i].x} 145)` : undefined}
              className="timings-axis">{record.id}</text>
          </g>)}
          {records.map((record, i) => <g key={record.id} role="button" tabIndex={0}
            className="timings-point" aria-haspopup="dialog"
            aria-label={`Call ${record.id}, ${metric.toLowerCase()}: ${duration(values[i])}. ${record.url}`}
            onClick={(event) => { origin.current = event.currentTarget; setSelected(record); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                origin.current = event.currentTarget;
                setSelected(record);
              }
            }}>
            <rect x={points[i].x - hitWidth / 2} y={points[i].y - 12} width={hitWidth} height="24" className="timings-hit" />
            <circle cx={points[i].x} cy={points[i].y} r="4" className="timings-marker" />
          </g>)}
        </svg>}
    </div>
    <button ref={toggle} className="timings-toggle" aria-pressed={includeParsing}
      onClick={() => setIncludeParsing((value) => !value)}>Include parsing</button>
    {selected && <TimingDialog record={selected} origin={origin.current} fallback={toggle}
      onClose={() => setSelected(null)} />}
  </figure>;
}

function TimingDialog({ record, origin, fallback, onClose }: {
  record: TimingRecord; origin: SVGGElement | null; fallback: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (origin?.isConnected) origin.focus();
      else fallback.current?.focus();
    };
  }, [origin, fallback]);
  return <dialog ref={dialog} className="timing-dialog" aria-labelledby="timing-title"
    aria-describedby="timing-explanation" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h1 id="timing-title">Request details</h1>
    <table aria-label="Request timing details"><tbody>
      <tr><th scope="row">API URL</th><td className="timing-url">{record.url}</td></tr>
      <tr><th scope="row">Request time</th><td>{duration(record.requestMs)}</td></tr>
      <tr><th scope="row">Parse time</th><td>{duration(record.parseMs)}</td></tr>
      <tr><th scope="row">Total time</th><td>{duration(record.totalMs)}</td></tr>
    </tbody></table>
    <p id="timing-explanation">Parse time includes downloading and decoding the response body.</p>
    <div className="dialog-actions"><button autoFocus onClick={onClose}>Close</button></div>
  </dialog>;
}
