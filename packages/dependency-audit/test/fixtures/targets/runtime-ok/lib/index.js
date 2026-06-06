/* oxlint-disable import/no-unassigned-import -- fixture: intentional imports under audit */
import leftpad from 'leftpad';
import { sub } from 'exporter/sub';
import './util.js';

export const value = leftpad(sub);
