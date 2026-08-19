import leftpad from 'leftpad';
import * as missing from 'missingdep';
export * from 'reexported-missing';

const require = (id) => id;
require('local-require');

export { leftpad, missing };
