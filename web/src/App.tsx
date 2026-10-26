import { useEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection } from 'geojson';
import { errorMessage, normalizeApiUrl } from './api';
import { coverageOutline, insetBounds, viewportBounds } from './bounds';
import type { Bounds } from './bounds';
import { DatasetSession } from './session';
import { timingHistory } from './timings';
import { RequestTimings } from './RequestTimings';

setWorkerUrl(workerUrl);
const collection = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const session = useRef<DatasetSession | null>(null);
  const featuresRef = useRef<Feature[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [connection, setConnection] = useState<{ url: string; id: number } | null>(null);
  const [timings, recordTiming] = useReducer(timingHistory, []);
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [selectedBrannvesen, setSelectedBrannvesen] = useState('');
  const [filterEnabled, setFilterEnabled] = useState(false);
  const selection = filterEnabled ? selectedBrannvesen : '';
  const [bboxEnabled, setBboxEnabled] = useState(false);
  const [bufferEnabled, setBufferEnabled] = useState(true);
  const [showBuffer, setShowBuffer] = useState(false);
  const [coverage, setCoverage] = useState<Bounds[] | undefined>();
  const bboxActive = bboxEnabled && selection === '';
  const canShowBuffer = !!connection && mapReady && bboxActive && bufferEnabled;
  const [values, setValues] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState({ loading: false, error: null as string | null });
  const [discovery, setDiscovery] = useState({ loading: false, error: null as string | null });

  useEffect(() => {
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: mapContainer.current!,
        style: 'https://tiles.openfreemap.org/styles/dark',
        center: [15, 65],
        zoom: 3.5,
        bounds: [[4, 57], [32, 72]],
        fitBoundsOptions: { padding: 45 },
      });
    } catch (error) {
      setMapError(`Map unavailable: ${errorMessage(error)}`);
      return;
    }
    map.current = instance;
    instance.addControl(new NavigationControl(), 'bottom-right');
    instance.on('error', (event) => setMapError(`Basemap: ${event.error.message}`));
    instance.on('load', () => {
      instance.addSource('query-bbox', { type: 'geojson', data: collection([]) });
      instance.addLayer({
        id: 'query-bbox', type: 'line', source: 'query-bbox',
        paint: { 'line-color': '#16a34a', 'line-width': 3 },
      });
      instance.addSource('fetched-buffer', { type: 'geojson', data: collection([]) });
      instance.addLayer({
        id: 'fetched-buffer', type: 'line', source: 'fetched-buffer',
        paint: { 'line-color': '#ef4444', 'line-width': 3 },
      });
      instance.addSource('stations', { type: 'geojson', data: collection(featuresRef.current) });
      instance.addLayer({
        id: 'stations', type: 'circle', source: 'stations',
        paint: {
          'circle-radius': 5,
          'circle-color': '#bb342a',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
      setMapReady(true);
    });
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!connection) return;
    setValues([]);
    featuresRef.current = [];
    setCount(0);
    (map.current?.getSource('stations') as GeoJSONSource | undefined)?.setData(collection([]));
    let fitted = false;
    const current = new DatasetSession(connection.url, {
      onFeatures: (features) => {
        featuresRef.current = features;
        setCount(features.length);
        (map.current?.getSource('stations') as GeoJSONSource | undefined)?.setData(collection(features));
      },
      onStatus: setStatus,
      onDiscovery: setDiscovery,
      onValues: setValues,
      onCoverage: setCoverage,
      onTiming: recordTiming,
      onHeader: (header) => {
        const extent = header.envelope;
        if (fitted || !map.current || !extent || extent.length !== 4 || !Array.from(extent).every(Number.isFinite)) return;
        fitted = true;
        map.current.fitBounds([[extent[0], extent[1]], [extent[2], extent[3]]], {
          padding: 45, duration: 0, maxZoom: 12,
        });
      },
    });
    session.current = current;
    void current.discover();
    return () => {
      current.dispose();
      session.current = null;
    };
  }, [connection]);

  useEffect(() => {
    if (!mapReady) return;
    const outline = showBuffer && canShowBuffer && coverage ? coverageOutline(coverage) : undefined;
    (map.current?.getSource('fetched-buffer') as GeoJSONSource | undefined)
      ?.setData(collection(outline ? [outline] : []));
  }, [mapReady, showBuffer, canShowBuffer, coverage]);

  useEffect(() => {
    if (!connection || !mapReady || !map.current) return;
    const instance = map.current;
    const current = session.current!;
    let frame: number | undefined;
    const updateArea = () => {
      const canvas = instance.getCanvas();
      const inset = bboxActive ? insetBounds(instance, canvas.clientWidth, canvas.clientHeight) : null;
      (instance.getSource('query-bbox') as GeoJSONSource).setData(collection(inset ? [inset.outline] : []));
      const bounds = instance.getBounds();
      return inset?.bounds ?? viewportBounds(
        bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
      );
    };
    // Apply all query settings atomically and invalidate incompatible coverage/work.
    void current.setFilter(selection, updateArea(), bufferEnabled);
    const update = () => {
      frame = undefined;
      void current.setBounds(updateArea());
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    const finish = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      update();
    };
    instance.on('move', schedule);
    instance.on('moveend', finish);
    instance.on('resize', schedule);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      instance.off('move', schedule);
      instance.off('moveend', finish);
      instance.off('resize', schedule);
    };
  }, [connection, mapReady, bboxActive, selection, bufferEnabled]);

  const countLabel = `${count.toLocaleString()} features${selection ? ' matching filter' : bboxActive ? ' in bbox' : ' in view'}`;

  return (
    <main className="workspace">
      <section className="controls" aria-label="Map controls">
        <header className="sidebar-header">
          <div className="connection-heading">
            <strong>Flatserve</strong>
            <button aria-haspopup="dialog" onClick={() => setConnectionOpen(true)}>Connect</button>
          </div>
          <small className="api-url" title={connection?.url}>{connection?.url ?? 'Not connected'}</small>
        </header>
        <section className="sidebar-section" aria-labelledby="options-heading">
          <h2 id="options-heading">Options</h2>
          <ul className="control-tree options-tree">
            <li>
              <button disabled={!connection || !mapReady || selection !== ''} aria-pressed={bboxActive}
                onClick={() => setBboxEnabled(!bboxEnabled)}>BBox</button>
            </li>
            <li>
              <button disabled={!connection || !mapReady || selection !== ''} aria-pressed={bufferEnabled}
                title="Fetch an extra 25% on each side of the viewport or BBox to reduce requests while moving."
                onClick={() => setBufferEnabled(!bufferEnabled)}>Buffer</button>
              <ul>
                <li>
                  <button disabled={!canShowBuffer} aria-pressed={showBuffer}
                    title="Show a red outline around the last successfully fetched buffer coverage."
                    onClick={() => setShowBuffer(!showBuffer)}>Show buffer</button>
                </li>
              </ul>
            </li>
          </ul>
        </section>
        <section className="sidebar-section" aria-labelledby="status-heading">
          <h2 id="status-heading">Status</h2>
          <div className="status" role="status" aria-live="polite">
            {!connection ? 'Connect to an API to view fire stations.'
              : status.loading ? `Loading… ${countLabel}`
              : status.error ? `${countLabel} loaded`
              : bboxActive ? countLabel
              : count === 0 ? 'No features found.'
              : `${count.toLocaleString()} features${selection ? ' matching filter' : ' in view'}`}
          </div>
          {status.error && <div className="error" role="alert">{status.error} <button onClick={() => {
            void session.current?.refresh();
          }}>Retry</button></div>}
          {mapError && <small className="error" role="alert">{mapError}</small>}
          <RequestTimings key={connection?.id ?? 0} records={timings} />
        </section>
        <form className="sidebar-section filter-panel" aria-labelledby="filter-heading" onSubmit={(event) => {
          event.preventDefault();
          if (values.includes(selectedBrannvesen)) setFilterEnabled((enabled) => !enabled);
        }}>
          <h2 id="filter-heading">Filter</h2>
          <ul className="control-tree filter-tree">
            <li>
              <label htmlFor="brannvesen">Brannvesen</label>
              <select id="brannvesen" disabled={!connection} value={selectedBrannvesen} onChange={(event) => {
                setSelectedBrannvesen(event.target.value);
              }}>
                <option value="" disabled>Select brannvesen</option>
                {values.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <ul>
                <li>
                  <button type="submit" disabled={!values.includes(selectedBrannvesen)} aria-pressed={filterEnabled}>Filter</button>
                </li>
              </ul>
            </li>
          </ul>
          {discovery.loading && <small>Loading filter values…</small>}
          {discovery.error && <small className="error" role="alert">Filters: {discovery.error} <button type="button" onClick={() => {
            void session.current?.discover();
          }}>Retry filters</button></small>}
        </form>
      </section>
      <div ref={mapContainer} className="map" aria-label="Map of fire stations" />
      <ConnectionDialog open={connectionOpen} initialUrl={connection?.url ?? 'http://localhost:5220'}
        canDismiss={!!connection} onClose={() => setConnectionOpen(false)} onConnect={(url) => {
          setSelectedBrannvesen('');
          setFilterEnabled(false);
          session.current?.dispose();
          recordTiming(null);
          setConnection((previous) => ({ url, id: (previous?.id ?? 0) + 1 }));
          setConnectionOpen(false);
        }} />
    </main>
  );
}

function ConnectionDialog({ open, initialUrl, canDismiss, onClose, onConnect }: {
  open: boolean; initialUrl: string; canDismiss: boolean;
  onClose: () => void; onConnect: (url: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setUrl(initialUrl);
      setError('');
      dialog.current?.showModal();
    } else dialog.current?.close();
  }, [open, initialUrl]);
  function submit(event: FormEvent) {
    event.preventDefault();
    try { onConnect(normalizeApiUrl(url)); }
    catch (error) { setError(errorMessage(error)); }
  }
  return <dialog ref={dialog} aria-labelledby="connection-title" onCancel={(event) => {
    if (!canDismiss) event.preventDefault();
    else onClose();
  }}>
    <form onSubmit={submit}>
      <h1 id="connection-title">Connect to Flatserve</h1>
      <p>Enter the API URL to explore Norway’s fire stations.</p>
      <label htmlFor="api-url">API URL</label>
      <input id="api-url" type="url" required autoFocus value={url}
        placeholder="http://localhost:5220" aria-describedby={error ? 'url-error' : undefined}
        onChange={(event) => { setUrl(event.target.value); setError(''); }} />
      {error && <p className="error" id="url-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        {canDismiss && <button type="button" onClick={onClose}>Cancel</button>}
        <button type="submit">Connect</button>
      </div>
    </form>
  </dialog>;
}
