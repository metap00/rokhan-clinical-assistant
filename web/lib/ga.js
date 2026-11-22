// Gestational age. Everything goes through the last menstrual period (DUM): DPN = DUM + 280 days.
import { addDays, daysBetween } from './format.js';

export const dumFromDpn = (dpn) => addDays(dpn, -280);
export const dpnFromDum = (dum) => addDays(dum, 280);
// "At the scan on `date` she was `weeks` weeks and `days` days."
export const dumFromEco = (date, weeks, days = 0) => addDays(date, -(Number(weeks) * 7 + Number(days)));

// Age on `date`: { total, weeks, days }. total can be negative (date before the DUM).
export function gaOn(dum, date) {
  const total = daysBetween(dum, date);
  return { total, weeks: Math.floor(total / 7), days: ((total % 7) + 7) % 7 };
}

export function gaLabel({ weeks, days }) {
  const w = weeks === 1 ? '1 săptămână' : `${weeks} ${weeks >= 20 ? 'de ' : ''}săptămâni`;
  const d = days === 1 ? '1 zi' : `${days} zile`;
  return `${w} și ${d}`;
}
