import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection } from 'geojson';
import { errorMessage, normalizeApiUrl } from './api';
import { viewportBounds } from './bounds';
import { DatasetSession } from './session';

setWorkerUrl(workerUrl);
const collection = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const session = useRef<DatasetSession | null>(null);
  const featuresRef = useRef<Feature[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [connection, setConnection] = useState<{ url: string } | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selection, setSelection] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState({ loading: false, error: null as string | null });
  const [discovery, setDiscovery] = useState({ loading: false, error: null as string | null });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: mapContainer.current!,
        style: 'https://demotiles.maplibre.org/style.json',
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
    instance.on('movestart', () => {
      clearTimeout(timer);
      session.current?.cancelViewport();
    });
    instance.on('moveend', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const bounds = instance.getBounds();
        void session.current?.setBounds(viewportBounds(
          bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
        ));
      }, 250);
    });
    return () => {
      clearTimeout(timer);
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!connection) return;
    setSelection('');
    setValues([]);
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
    if (!connection || !mapReady || !map.current) return;
    const bounds = map.current.getBounds();
    void session.current?.setBounds(viewportBounds(
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
    ));
  }, [connection, mapReady]);

  return (
    <main>
      <div ref={mapContainer} className="map" aria-label="Map of fire stations" />
      <section className="controls" aria-label="Map controls">
        <div className="toolbar">
          <strong>Flatserve</strong>
          <button onClick={() => setConnectionOpen(true)}>Connection</button>
          <button disabled={!connection} aria-expanded={filterOpen} aria-controls="filter-panel"
            onClick={() => setFilterOpen(!filterOpen)}>Filter{selection ? ' •' : ''}</button>
        </div>
        {connection && <small className="api-url" title={connection.url}>{connection.url}</small>}
        {filterOpen && <div id="filter-panel" className="filter-panel">
          <label htmlFor="brannvesen">Brannvesen</label>
          <select id="brannvesen" value={selection} onChange={(event) => {
            setSelection(event.target.value);
            void session.current?.setFilter(event.target.value);
          }}>
            <option value="">All brannvesen</option>
            {values.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          {discovery.loading && <small>Loading filter values…</small>}
          {discovery.error && <small role="alert">Filters: {discovery.error} <button onClick={() => {
            void session.current?.discover();
          }}>Retry filters</button></small>}
        </div>}
        <div className="status" role="status" aria-live="polite">
          {!connection ? 'Connect to an API to view fire stations.'
            : status.loading ? `Loading… ${count.toLocaleString()} features`
            : status.error ? `${count.toLocaleString()} features loaded`
            : count === 0 ? 'No features found.'
            : `${count.toLocaleString()} features${selection ? ' matching filter' : ' in view'}`}
        </div>
        {status.error && <div className="error" role="alert">{status.error} <button onClick={() => {
          void session.current?.refresh();
        }}>Retry</button></div>}
        {mapError && <small className="error" role="alert">{mapError}</small>}
      </section>
      <ConnectionDialog open={connectionOpen} initialUrl={connection?.url ?? 'http://localhost:5220'}
        canDismiss={!!connection} onClose={() => setConnectionOpen(false)} onConnect={(url) => {
          setConnection({ url });
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
