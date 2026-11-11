import { useEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { errorMessage, featureLayer, fetchAuthorizedArea, fetchIndexes, normalizeApiUrl } from './api';
import type { FgbLayer, TextIndex } from './api';
import { coverageOutline, insetBounds, viewportBounds } from './bounds';
import type { Bounds } from './bounds';
import { DatasetSession } from './session';
import { timingHistory } from './timings';
import { RequestTimings } from './RequestTimings';
import { fetchStylesheet, renderStyledLayers } from './stylesheet';
import type { PreparedStylesheet } from './stylesheet';

setWorkerUrl(workerUrl);
const viewportColor = '#16a34a';
const bufferColor = '#ef4444';
const layerColors = ['#bb342a', '#38bdf8', '#fbbf24', '#a78bfa', '#34d399', '#fb923c'];
function layerColor(id: string): string {
  if (id === 'dataset') return layerColors[0];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return layerColors[hash % layerColors.length];
}
const featureColor: ExpressionSpecification = ['coalesce', ['get', '__flatserveColor'], '#bb342a'];

function bboxLabel(map: MapLibreMap, text: string, color: string, position: [number, number]): Marker {
  const element = document.createElement('div');
  element.className = 'bbox-label';
  element.textContent = text;
  element.style.color = color;
  return new Marker({ element, anchor: 'bottom-left', offset: [0, -6] })
    .setLngLat(position).addTo(map);
}

const collection = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const session = useRef<DatasetSession | null>(null);
  const featuresRef = useRef<Feature[]>([]);
  const styleRenderer = useRef<ReturnType<typeof renderStyledLayers> | null>(null);
  const [stylesheet, setStylesheet] = useState<{ connection: NonNullable<typeof connection>; prepared: PreparedStylesheet } | null>(null);
  const [styleStatus, setStyleStatus] = useState({ loading: false, error: null as string | null });
  const [styleRetry, retryStyle] = useReducer((attempt: number) => attempt + 1, 0);
  const [styledDatasets, setStyledDatasets] = useState<Set<string>>(new Set());
  const [styleWarnings, setStyleWarnings] = useState<string[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [connection, setConnection] = useState<{ url: string; id: number } | null>(null);
  const [timings, recordTiming] = useReducer(timingHistory, []);
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [selectedUser, setSelectedUser] = useState<number | null>(null);
  const [authorizedAreaEnabled, setAuthorizedAreaEnabled] = useState(false);
  const [authorizedArea, setAuthorizedArea] = useState<{
    connection: NonNullable<typeof connection>; userId: number; feature: Feature<Polygon>;
  } | null>(null);
  const authorizedAreaCache = useRef<typeof authorizedArea>(null);
  const [authorizedAreaStatus, setAuthorizedAreaStatus] = useState({ loading: false, error: null as string | null });
  const [authorizedAreaRetry, retryAuthorizedArea] = useReducer((attempt: number) => attempt + 1, 0);
  const canShowAuthorizedArea = !!connection && mapReady && selectedUser !== null;
  const [indexes, setIndexes] = useState<TextIndex[]>([]);
  const [selectedAttribute, setSelectedAttribute] = useState('');
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState({ loading: false, error: null as string | null });
  const [indexRetry, retryIndexes] = useReducer((attempt: number) => attempt + 1, 0);
  const selectedIndex = indexes.find((index) => index.attribute === selectedAttribute);
  const values = selectedIndex?.values ?? [];
  let valuePlaceholder = '';
  while (values.includes(valuePlaceholder)) valuePlaceholder += '_';
  const [filterEnabled, setFilterEnabled] = useState(false);
  const selection = filterEnabled && selectedIndex && selectedValue !== null ? JSON.stringify([selectedAttribute, selectedValue]) : '';
  const [bboxEnabled, setBboxEnabled] = useState(false);
  const [bufferEnabled, setBufferEnabled] = useState(true);
  const [showBuffer, setShowBuffer] = useState(false);
  const [coverage, setCoverage] = useState<Bounds[] | undefined>();
  const bboxActive = bboxEnabled && selection === '';
  const canShowBuffer = !!connection && mapReady && bboxActive && bufferEnabled;
  const [features, setFeatures] = useState<Feature[]>([]);
  const [layers, setLayers] = useState<FgbLayer[]>([]);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const visibleFeatures = features.filter((feature) => !hiddenLayers.has(featureLayer(feature)));
  const count = visibleFeatures.length;

  useEffect(() => {
    const rendered = visibleFeatures.map((feature) => ({ ...feature,
      properties: { ...feature.properties, __flatserveColor: layerColor(featureLayer(feature)) },
    }));
    featuresRef.current = rendered;
    if (styleRenderer.current) styleRenderer.current.update(rendered);
    else if (mapReady) (map.current?.getSource('stations') as GeoJSONSource | undefined)?.setData(collection(rendered));
  }, [features, hiddenLayers, mapReady]);
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
      instance.addSource('stations', { type: 'geojson', data: collection(featuresRef.current) });
      instance.addLayer({
        id: 'dataset-polygons', type: 'fill', source: 'stations',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': featureColor, 'fill-opacity': 0.18 },
      });
      instance.addLayer({
        id: 'dataset-lines', type: 'line', source: 'stations',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': featureColor, 'line-width': 2 },
      });
      instance.addLayer({
        id: 'stations', type: 'circle', source: 'stations',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 5,
          'circle-color': featureColor,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
      instance.addSource('authorized-area', { type: 'geojson', data: collection([]) });
      instance.addLayer({
        id: 'authorized-area-fill', type: 'fill', source: 'authorized-area',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.12 },
      });
      instance.addLayer({
        id: 'authorized-area-outline', type: 'line', source: 'authorized-area',
        paint: { 'line-color': '#38bdf8', 'line-width': 2 },
      });
      instance.addSource('query-bbox', { type: 'geojson', data: collection([]) });
      instance.addLayer({
        id: 'query-bbox', type: 'line', source: 'query-bbox',
        paint: { 'line-color': viewportColor, 'line-width': 3 },
      });
      instance.addSource('fetched-buffer', { type: 'geojson', data: collection([]) });
      instance.addLayer({
        id: 'fetched-buffer', type: 'line', source: 'fetched-buffer',
        paint: { 'line-color': bufferColor, 'line-width': 3 },
      });
      setMapReady(true);
    });
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    setStylesheet(null);
    setStyleStatus({ loading: !!connection, error: null });
    if (!connection) return;
    const controller = new AbortController();
    void fetchStylesheet(connection.url, controller.signal).then((prepared) => {
      if (controller.signal.aborted) return;
      setStylesheet({ connection, prepared });
      setStyleStatus({ loading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setStyleStatus({ loading: false, error: errorMessage(error) });
    });
    return () => { controller.abort(); };
  }, [connection, styleRetry]);

  useEffect(() => {
    setStyledDatasets(new Set());
    setStyleWarnings([]);
    if (!mapReady || !map.current) return;
    const instance = map.current;
    // Restore fallback data immediately while loading or switching connections.
    (instance.getSource('stations') as GeoJSONSource).setData(collection(featuresRef.current));
    if (!stylesheet || stylesheet.connection !== connection || !layers.length) return;
    try {
      const renderer = renderStyledLayers(instance, layers.map((layer) => layer.id), stylesheet.prepared);
      styleRenderer.current = renderer;
      renderer.update(featuresRef.current);
      setStyledDatasets(renderer.styled);
      setStyleWarnings(renderer.warnings);
      return () => {
        styleRenderer.current = null;
        if (map.current === instance) renderer.cleanup();
      };
    } catch (error) {
      setStyleWarnings([errorMessage(error)]);
    }
  }, [mapReady, connection, stylesheet, layers]);

  useEffect(() => {
    if (authorizedAreaCache.current?.connection !== connection || authorizedAreaCache.current?.userId !== selectedUser) {
      authorizedAreaCache.current = null;
      setAuthorizedArea(null);
    }
    setAuthorizedAreaStatus({ loading: false, error: null });
    if (!authorizedAreaEnabled || !connection || !mapReady || selectedUser === null || authorizedAreaCache.current) return;
    const controller = new AbortController();
    setAuthorizedAreaStatus({ loading: true, error: null });
    void fetchAuthorizedArea(connection.url, selectedUser, controller.signal).then((feature) => {
      if (controller.signal.aborted) return;
      const loaded = { connection, userId: selectedUser, feature };
      authorizedAreaCache.current = loaded;
      setAuthorizedArea(loaded);
      setAuthorizedAreaStatus({ loading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setAuthorizedAreaStatus({ loading: false, error: errorMessage(error) });
    });
    return () => { controller.abort(); };
  }, [connection, selectedUser, mapReady, authorizedAreaEnabled, authorizedAreaRetry]);

  useEffect(() => {
    if (!mapReady) return;
    const visible = authorizedAreaEnabled && authorizedArea?.connection === connection && authorizedArea.userId === selectedUser;
    (map.current?.getSource('authorized-area') as GeoJSONSource | undefined)
      ?.setData(collection(visible ? [authorizedArea.feature] : []));
  }, [mapReady, authorizedAreaEnabled, authorizedArea, connection, selectedUser]);

  useEffect(() => {
    setIndexes([]);
    setSelectedAttribute('');
    setSelectedValue(null);
    setFilterEnabled(false);
    setIndexStatus({ loading: false, error: null });
    if (!connection) return;
    const controller = new AbortController();
    setIndexStatus({ loading: true, error: null });
    void fetchIndexes(connection.url, controller.signal).then((available) => {
      if (controller.signal.aborted) return;
      setIndexes(available);
      setSelectedAttribute(available[0]?.attribute ?? '');
      setIndexStatus({ loading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setIndexStatus({ loading: false, error: errorMessage(error) });
    });
    return () => { controller.abort(); };
  }, [connection, indexRetry]);

  useEffect(() => {
    if (!connection) return;
    featuresRef.current = [];
    setFeatures([]);
    setLayers([]);
    setHiddenLayers(new Set());
    (map.current?.getSource('stations') as GeoJSONSource | undefined)?.setData(collection([]));
    let fitted = false;
    const current = new DatasetSession(connection.url, {
      onFeatures: (features) => {
        setFeatures(features);
      },
      onStatus: setStatus,
      onDiscovery: setDiscovery,
      onLayers: setLayers,
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
    if (!outline || !map.current || !coverage?.length) return;
    const label = bboxLabel(map.current, 'Buffer bbox', bufferColor, [coverage[0].minX, coverage[0].maxY]);
    return () => { label.remove(); };
  }, [mapReady, showBuffer, canShowBuffer, coverage]);

  useEffect(() => {
    if (!connection || !mapReady || !map.current) return;
    const instance = map.current;
    const current = session.current!;
    let frame: number | undefined;
    let label: Marker | undefined;
    const updateArea = () => {
      const canvas = instance.getCanvas();
      const inset = bboxActive ? insetBounds(instance, canvas.clientWidth, canvas.clientHeight) : null;
      (instance.getSource('query-bbox') as GeoJSONSource).setData(collection(inset ? [inset.outline] : []));
      if (inset) {
        const corner = inset.outline.geometry.coordinates[3] as [number, number];
        label ??= bboxLabel(instance, 'Viewport bbox', viewportColor, corner);
        label.setLngLat(corner);
      }
      const bounds = instance.getBounds();
      return inset?.bounds ?? viewportBounds(
        bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
      );
    };
    // Apply all query settings atomically and invalidate incompatible coverage/work.
    void current.setTextFilter(selection ? { attribute: selectedAttribute, value: selectedValue! } : null, updateArea(), bufferEnabled);
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
      label?.remove();
    };
  }, [connection, mapReady, bboxActive, selection, bufferEnabled]);

  useEffect(() => {
    void session.current?.setUser(selectedUser);
  }, [connection, selectedUser]);

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
            <li>
              <label htmlFor="user">Select user</label>
              <select id="user" value={selectedUser ?? ''} onChange={(event) => {
                setSelectedUser(Number(event.target.value));
              }}>
                <option value="" disabled>Select user…</option>
                <option value="0">Agder</option>
                <option value="1">Oslo</option>
                <option value="2">Norway</option>
              </select>
              <ul>
                <li>
                  <button disabled={!canShowAuthorizedArea} aria-pressed={authorizedAreaEnabled}
                    onClick={() => setAuthorizedAreaEnabled(!authorizedAreaEnabled)}>Show authorized area</button>
                  {authorizedAreaStatus.loading && <small aria-live="polite">Loading authorized area…</small>}
                  {authorizedAreaStatus.error && <div className="error" role="alert">
                    {authorizedAreaStatus.error} <button onClick={retryAuthorizedArea}>Retry authorized area</button>
                  </div>}
                </li>
              </ul>
            </li>
          </ul>
        </section>
        <section className="sidebar-section" aria-labelledby="layers-heading">
          <h2 id="layers-heading">Layers</h2>
          {!layers.length && <small>{discovery.loading ? 'Loading layers…' : 'No layers loaded.'}</small>}
          {styleStatus.loading && <small>Loading stylesheet…</small>}
          {styleStatus.error && <div className="error" role="note">{styleStatus.error} Using basic styling.
            <button onClick={retryStyle}>Retry stylesheet</button>
          </div>}
          {styleWarnings.length > 0 && <div className="error" role="note">{styleWarnings.join(' ')}
            <button onClick={retryStyle}>Retry stylesheet</button>
          </div>}
          <ul className="layer-list">
            {layers.map((layer) => <li key={layer.id}>
              <label>
                <input type="checkbox" checked={!hiddenLayers.has(layer.id)} onChange={() => {
                  setHiddenLayers((previous) => {
                    const next = new Set(previous);
                    if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
                    return next;
                  });
                }} />
                {styledDatasets.has(layer.id) ? <small>Styled</small>
                  : <span className="layer-swatch" style={{ backgroundColor: layerColor(layer.id) }} />}
                <span className="layer-name">{layer.id}</span>
                <small>{features.filter((feature) => featureLayer(feature) === layer.id).length.toLocaleString()}</small>
              </label>
            </li>)}
          </ul>
        </section>
        <section className="sidebar-section" aria-labelledby="status-heading">
          <h2 id="status-heading">Status</h2>
          <div className="status" role="status" aria-live="polite">
            {!connection ? 'Connect to an API to view layers.'
              : selectedUser === null ? 'Select a user to load layers.'
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
          if (selectedUser !== null && selectedValue !== null && values.includes(selectedValue)) setFilterEnabled((enabled) => !enabled);
        }}>
          <h2 id="filter-heading">Filter</h2>
          <ul className="control-tree filter-tree">
            <li>
              <label htmlFor="filter-attribute">Index</label>
              <select id="filter-attribute" disabled={indexStatus.loading || !indexes.length} value={selectedAttribute}
                onChange={(event) => {
                  setSelectedAttribute(event.target.value);
                  setSelectedValue(null);
                  setFilterEnabled(false);
                }}>
                {!indexes.length && <option value="">Select index</option>}
                {indexes.map((index) => <option key={index.attribute} value={index.attribute}>{index.attribute}</option>)}
              </select>
              {selectedIndex && <small>Indexed in {selectedIndex.layers.join(', ')}</small>}
              <label htmlFor="filter-value">{selectedAttribute ? selectedAttribute[0].toUpperCase() + selectedAttribute.slice(1) : 'Value'}</label>
              <select id="filter-value" disabled={!selectedIndex || indexStatus.loading} value={selectedValue ?? valuePlaceholder} onChange={(event) => {
                setSelectedValue(event.target.value);
              }}>
                <option value={valuePlaceholder} disabled>Select value</option>
                {values.map((value) => <option key={value} value={value}>{value === '' ? '(empty)' : value}</option>)}
              </select>
              <ul>
                <li>
                  <button type="submit" disabled={selectedUser === null || selectedValue === null || !values.includes(selectedValue)} aria-pressed={filterEnabled}>Filter</button>
                </li>
              </ul>
            </li>
          </ul>
          {indexStatus.loading && <small>Loading indexes…</small>}
          {connection && !indexStatus.loading && !indexStatus.error && !indexes.length && <small>No text indexes are available.</small>}
          {indexStatus.error && <small className="error" role="alert">Indexes: {indexStatus.error} <button type="button" onClick={retryIndexes}>Retry indexes</button></small>}
          {discovery.error && <small className="error" role="alert">Layers: {discovery.error} <button type="button" onClick={() => {
            void session.current?.discover();
          }}>Retry layers</button></small>}
        </form>
      </section>
      <div ref={mapContainer} className="map" aria-label="Map of FGB layers" />
      <ConnectionDialog open={connectionOpen} initialUrl={connection?.url ?? 'http://localhost:5220'}
        onClose={() => setConnectionOpen(false)} onConnect={(url) => {
          if (connection) setSelectedUser(null);
          setAuthorizedAreaEnabled(false);
          authorizedAreaCache.current = null;
          setAuthorizedArea(null);
          setSelectedValue(null);
          setFilterEnabled(false);
          session.current?.dispose();
          recordTiming(null);
          setConnection((previous) => ({ url, id: (previous?.id ?? 0) + 1 }));
          setConnectionOpen(false);
        }} />
    </main>
  );
}

function ConnectionDialog({ open, initialUrl, onClose, onConnect }: {
  open: boolean; initialUrl: string;
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
  return <dialog ref={dialog} aria-labelledby="connection-title" onCancel={onClose}>
    <form onSubmit={submit}>
      <h1 id="connection-title">Connect to Flatserve</h1>
      <p>Enter the API URL to explore its FGB layers.</p>
      <label htmlFor="api-url">API URL</label>
      <input id="api-url" type="url" required autoFocus value={url}
        placeholder="http://localhost:5220" aria-describedby={error ? 'url-error' : undefined}
        onChange={(event) => { setUrl(event.target.value); setError(''); }} />
      {error && <p className="error" id="url-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit">Connect</button>
      </div>
    </form>
  </dialog>;
}
