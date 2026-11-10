import { icon } from './icons.js';
export { icon };
export function escape(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function money(value: unknown): string {
  if (value == null) return '—';
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(String(value));
  if (!match) { const number = Number(value); return Number.isFinite(number) ? number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
  const fraction = match[3] || '';
  const cents = BigInt(match[2]) * 100n + BigInt((fraction + '00').slice(0, 2)) + (Number(fraction[2] || '0') >= 5 ? 1n : 0n);
  const whole = String(cents / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${match[1] === '-' && cents > 0n ? '-' : ''}${whole}.${String(cents % 100n).padStart(2, '0')}`;
}
export function unitPrice(value: unknown): string {
  if (value == null) return '—';
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(String(value));
  if (!match) return money(value);
  return `${match[1] === '-' ? '-' : ''}${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(match[3] || '').padEnd(2, '0')}`;
}
export function measure(value: number | null, digits = 2): string { return value == null ? '待校准' : value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
let toastTimer: ReturnType<typeof setTimeout>;
export function toast(message: string, error = false) {
  const container = document.querySelector('#toast') as HTMLElement;
  container.innerHTML = `${icon(error ? 'info' : 'check', 16)}<span>${escape(message)}</span>`;
  container.className = `toast visible ${error ? 'error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => container.classList.remove('visible'), 3500);
}
export function openDialog(title: string, content: string, options: { wide?: boolean; subtitle?: string; footer?: string } = {}): HTMLDialogElement {
  // Native close events are queued. Reusing a just-closed element can cancel
  // the next prompt's promise, so each prompt owns its dialog lifecycle.
  const previous = document.querySelector('#dialog') as HTMLDialogElement;
  if (previous?.open) previous.close();
  const dialog = document.createElement('dialog');
  dialog.id = 'dialog';
  if (previous) previous.replaceWith(dialog); else document.body.append(dialog);
  dialog.className = options.wide ? 'wide' : '';
  dialog.innerHTML = `<header class="dialog-head"><div><h2>${escape(title)}</h2>${options.subtitle ? `<p>${escape(options.subtitle)}</p>` : ''}</div><button type="button" class="icon-button" data-dialog-close aria-label="关闭">${icon('close')}</button></header><div class="dialog-body">${content}</div>${options.footer ? `<footer class="dialog-footer">${options.footer}</footer>` : ''}`;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[data-dialog-close]').addEventListener('click', () => dialog.close());
  return dialog;
}
export async function askNumber(title: string, label: string, value = '1', help = ''): Promise<number | null> {
  const dialog = openDialog(title, `<form id="number-form"><label class="field-label" for="number-value">${escape(label)}</label><input id="number-value" type="number" min="0.000001" step="any" required value="${escape(value)}" autofocus>${help ? `<p class="help">${escape(help)}</p>` : ''}<button type="submit" class="button primary full">确认</button></form>`);
  return new Promise(resolve => {
    let accepted = false;
    dialog.querySelector('form').addEventListener('submit', e => { e.preventDefault(); const number = Number((dialog.querySelector('input') as HTMLInputElement).value); if (!Number.isFinite(number) || number <= 0) return; accepted = true; resolve(number); dialog.close(); });
    dialog.addEventListener('close', () => { if (!accepted) resolve(null); }, { once: true });
  });
}
