import { sub } from 'exporter/sub';
// `./private` is not exposed by exporter's `exports` map — unresolved at runtime.
import { secret } from 'exporter/private';

export const value = [sub, secret];
