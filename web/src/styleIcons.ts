import type { StyleSpecification } from 'maplibre-gl';
import { errorMessage as getErrorMessage } from './api';

type EmbeddedIcons = {
  images: Map<string, HTMLImageElement | null>;
  errors: string[];
};

async function decodeSvg(svg: unknown, signal: AbortSignal): Promise<HTMLImageElement> {
  signal.throwIfAborted();
  if (typeof svg !== 'string' || !svg.trim()) throw new Error('Expected an inline SVG string.');
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  let abort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => {
        image.removeAttribute('src');
        reject(signal.reason);
      };
      image.onload = () => {
        if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve();
        else reject(new Error('The SVG must have nonzero dimensions.'));
      };
      image.onerror = () => reject(new Error('Unable to decode the SVG.'));
      signal.addEventListener('abort', abort, { once: true });
      image.src = url;
    });
    signal.throwIfAborted();
    return image;
  } finally {
    image.onload = null;
    image.onerror = null;
    signal.removeEventListener('abort', abort);
    URL.revokeObjectURL(url);
  }
}

export async function loadEmbeddedIcons(style: StyleSpecification, signal: AbortSignal): Promise<EmbeddedIcons> {
  signal.throwIfAborted();
  const result: EmbeddedIcons = { images: new Map(), errors: [] };
  const metadata = style.metadata;
  const icons = metadata && typeof metadata === 'object' && 'geoflatpack:icons' in metadata
    ? metadata['geoflatpack:icons']
    : undefined;
  if (icons === undefined) return result;
  if (!icons || typeof icons !== 'object' || Array.isArray(icons)) {
    result.errors.push('Expected geoflatpack:icons to map icon names to inline SVG strings.');
    return result;
  }

  // Decode everything before the renderer mutates the map, retaining failed names
  // so their references can be omitted without suppressing geometry or labels.
  await Promise.all(Object.entries(icons).map(async ([name, svg]) => {
    try {
      result.images.set(name, await decodeSvg(svg, signal));
    } catch (cause) {
      signal.throwIfAborted();
      result.images.set(name, null);
      result.errors.push(`Icon "${name}": ${getErrorMessage(cause)}`);
    }
  }));
  signal.throwIfAborted();
  return result;
}
