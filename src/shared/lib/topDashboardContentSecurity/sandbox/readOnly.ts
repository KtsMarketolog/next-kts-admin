/**
 * Blocks user-initiated file replacement in readonly reports; hydration remains permitted.
 * Uses READ_ONLY, allFileInputs and fileInputForDropTarget from the generic adapter.
 * Emitted into the enclosing runtime's lexical scope; preserve statement order.
 */
export function readOnlyAdapterScript() {
  return String.raw`  function lockFileInputs() {
    if (!READ_ONLY) return;
    document.querySelectorAll('input[type="file"]').forEach((input) => {
      if (!isFileInput(input)) return;
      if (!input.disabled) input.disabled = true;
      if (input.tabIndex !== -1) input.tabIndex = -1;
      if (input.getAttribute('aria-hidden') !== 'true') input.setAttribute('aria-hidden', 'true');
    });
  }

  function blockOwnerFileInteraction(event) {
    if (!READ_ONLY) return;
    const target = event.target;
    const transfer = event.dataTransfer || event.clipboardData;
    const hasFiles = transfer
      && (transfer.files.length > 0 || Array.from(transfer.types || []).includes('Files'));
    const isBlockedFileEvent = (event.type === 'click' && isFileInput(target))
      || ((event.type === 'drop' || event.type === 'dragenter' || event.type === 'dragover') && hasFiles)
      || (event.type === 'change' && event.isTrusted && isFileInput(target));
    if (!isBlockedFileEvent) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  if (READ_ONLY) {
    const readOnlyStyle = document.createElement('style');
    readOnlyStyle.textContent = 'input[type="file"],label[for="file"],label[for="folder"],label[for="snapInp"],#drop,#btnFiles,#btnDir,#btnSnapLoad,button[onclick*="pickFiles("],button[onclick*="connectFolder("],button[onclick*="refreshFromFolder("],button[data-kts-handler-onclick*="pickFiles("],button[data-kts-handler-onclick*="connectFolder("],button[data-kts-handler-onclick*="refreshFromFolder("]{display:none!important}';
    document.head.appendChild(readOnlyStyle);
    ['click', 'change', 'dragenter', 'dragover', 'drop'].forEach((type) => {
      document.addEventListener(type, blockOwnerFileInteraction, true);
    });
    const fileInputObserver = new MutationObserver(lockFileInputs);
    fileInputObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['disabled', 'type'],
      childList: true,
      subtree: true,
    });
    lockFileInputs();
  }

`;
}
