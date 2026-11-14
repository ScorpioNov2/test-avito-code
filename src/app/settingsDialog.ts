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

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly preferences: PreferenceStore,
  ) {
    this.themeSelect.replaceChildren(...getAllEditorThemes().map((theme) => new Option(theme.label, theme.id)));
    this.cancelButton.addEventListener('click', () => this.dialog.close());
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
    void this.wasmCacheManager.refresh();
  }
}
