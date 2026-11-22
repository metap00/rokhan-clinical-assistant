// CNP detection. The browser copy (web/lib/cnp.js) is checked against the same vectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { containsCnp } from '../server/store/cnp.mjs';

export const VECTORS = [
  // valid: together, inside text, split by spaces, dots, dashes
  ['1950305123456', true],
  ['CNP 2951201400124, internată azi', true],
  ['5000229001274', true], // 29 Feb 2000, a leap year
  ['7850701123454', true], // S = 7 (resident)
  ['1 950 305 123 456', true],
  ['195.0305.123.456', true],
  ['1950-305-123456', true],
  ['pacienta: 2951201400124.', true],
  // a bad control digit
  ['1950305123457', false],
  ['2951201400125', false],
  // a correct control digit but no such date
  ['6030229001270', false], // 29 Feb 2003
  ['1010229123454', false], // 29 Feb 1901
  ['1951331123452', false], // month 13
  ['0950305123456', false], // first digit 0
  // 13 valid digits inside a longer number
  ['41950305123456', false],
  ['19503051234567', false],
  ['1950305123456 7', false],
  ['1950305123456-7', false],
  // separators doubled, phones, accession numbers, dates
  ['1950305  123456', false],
  ['tel 0722 123 456', false],
  ['+40 722 123 456', false],
  ['2024110512345', false],
  ['Hb 11,2 g/dl; PLT 245.000; 22.11.2026', false],
  ['', false],
];

test('CNP vectors', () => {
  for (const [text, want] of VECTORS) assert.equal(containsCnp(text), want, JSON.stringify(text));
});
