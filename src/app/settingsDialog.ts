import { requireElement } from './domElements';
import { getAllEditorThemes } from './editorThemes/editorThemeRegistry';
import type { PreferenceStore } from './userPreferences';
import { WasmCacheManager } from './wasmCacheManager';

/** Popup Settings: tên hiển thị, theme, và bật/tắt nhãn tên trên con trỏ của người khác. */
export class SettingsDialog {
  private readonly form = requireElement<HTMLFormElement>('settings-form');
  private readonly nameInput = requireElement<HTMLInputElement>('settings-name-input');
  private readonly themeSelect = requireElement<HTMLSelectElement>('settings-theme-select');
  private readonly showNamesInput = requireElement<HTMLInputElement>('settings-show-names-input');
  private readonly cancelButton = requireElement<HTMLButtonElement>('settings-cancel-button');
  private readonly wasmCacheManager = new WasmCacheManager();
  private readonly manageWasmCacheButton = requireElement<HTMLButtonElement>('manage-wasm-cache-button');
  private readonly wasmCacheDialog = requireElement<HTMLDialogElement>('wasm-cache-dialog');
  private readonly closeWasmCacheButton = requireElement<HTMLButtonElement>('close-wasm-cache-dialog-button');
  private readonly doneWasmCacheButton = requireElement<HTMLButtonElement>('done-wasm-cache-dialog-button');

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly preferences: PreferenceStore,
  ) {
    this.themeSelect.replaceChildren(...getAllEditorThemes().map((theme) => new Option(theme.label, theme.id)));
    this.cancelButton.addEventListener('click', () => this.dialog.close());
    this.manageWasmCacheButton.addEventListener('click', () => {
      this.wasmCacheDialog.showModal();
      void this.wasmCacheManager.refresh();
    });
    this.closeWasmCacheButton.addEventListener('click', () => this.wasmCacheDialog.close());
    this.doneWasmCacheButton.addEventListener('click', () => this.wasmCacheDialog.close());
    // form method="dialog" tự đóng popup sau khi submit.
    this.form.addEventListener('submit', () => {
      this.preferences.update({
        displayName: this.nameInput.value,
        editorTheme: this.themeSelect.value,
        showRemoteNames: this.showNamesInput.checked,
      });
    });
  }

  open(): void {
    const { displayName, editorTheme, showRemoteNames } = this.preferences.value;
    this.nameInput.value = displayName;
    this.themeSelect.value = editorTheme;
    this.showNamesInput.checked = showRemoteNames;
    this.dialog.showModal();
  }
}
