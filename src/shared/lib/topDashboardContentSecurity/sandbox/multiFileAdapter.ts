import { TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS } from '../../topDashboardLimits';
import { getTopDashboardUploadLabel } from '../../topDashboardUploadLabels';
import {
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS,
} from '../../topDashboardMultiFileSnapshot';

/**
 * Discovers and captures generic file inputs, then restores them through the HTML's own handlers.
 * Uses the adapter protocol, readonly flags, restore state and send/report helpers.
 * Emitted into the enclosing runtime's lexical scope; preserve statement order.
 */
export function multiFileAdapterScript() {
  return String.raw`  const uploadInputLabel = ${getTopDashboardUploadLabel.toString()};
  function isFileInput(value) {
    return value instanceof HTMLInputElement && value.type === 'file';
  }

  function allFileInputs() {
    return Array.from(document.querySelectorAll('input[type="file"]')).filter(isFileInput);
  }

  function uniqueInputText(inputs, input, property) {
    const normalized = (candidate) => {
      const raw = candidate[property];
      if (typeof raw !== 'string' || !raw || raw !== raw.trim()) return null;
      const text = raw.normalize('NFC');
      if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(text)
        || new TextEncoder().encode(text).byteLength > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES}) return null;
      return text;
    };
    const value = normalized(input);
    if (!value) return null;
    return inputs.filter((candidate) => normalized(candidate) === value).length === 1
      ? value
      : null;
  }

  function multiFileTarget(input) {
    const inputs = allFileInputs();
    const index = inputs.indexOf(input);
    if (index < 0 || index > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX}) return null;
    return {
      id: uniqueInputText(inputs, input, 'id'),
      name: uniqueInputText(inputs, input, 'name'),
      index,
    };
  }

  // Report actual inputs, including fields created after the HTML has loaded.
  // File contents never travel with discovery messages.
  let uploadTargetsFingerprint = '';
  let uploadTargetsTimer = 0;
  function reportUploadTargets(force, requestId) {
    if (!MULTI_FILE_MODE || READ_ONLY) return;
    const targets = allFileInputs().filter((input) => !input.disabled).slice(0, ${TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS}).map((input) => ({
      target: multiFileTarget(input),
      multiple: input.multiple,
      directory: input.hasAttribute('webkitdirectory') || input.hasAttribute('directory'),
      accept: (input.accept || '').slice(0, 512),
      label: uploadInputLabel({
        ariaLabel: input.getAttribute('aria-label'),
        label: input.labels && input.labels[0] && input.labels[0].textContent,
        title: input.title,
        accept: input.accept || '',
        multiple: input.multiple,
        directory: input.hasAttribute('webkitdirectory') || input.hasAttribute('directory'),
        index: allFileInputs().indexOf(input),
      }),
    })).filter((entry) => entry.target);
    const fingerprint = JSON.stringify(targets);
    if (!force && fingerprint === uploadTargetsFingerprint) return;
    uploadTargetsFingerprint = fingerprint;
    window.parent.postMessage({ marker: MULTI_FILE_MARKER, type: 'upload-targets', targets, requestId }, '*');
  }

  if (MULTI_FILE_MODE && !READ_ONLY) {
    const targetsObserver = new MutationObserver(() => {
      if (uploadTargetsTimer) return;
      uploadTargetsTimer = window.setTimeout(() => {
        uploadTargetsTimer = 0;
        reportUploadTargets(false);
      }, 100);
    });
    targetsObserver.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['id', 'name', 'type', 'multiple', 'webkitdirectory', 'directory', 'accept', 'disabled', 'aria-label', 'title', 'for'],
    });
  }

  function fileInputForDropTarget(value) {
    if (isFileInput(value)) return value;
    if (!(value instanceof Element)) return null;

    const explicitOwner = value.closest('label[for],[data-file-input],[data-input],[aria-controls]');
    if (explicitOwner) {
      const reference = explicitOwner.getAttribute('for')
        || explicitOwner.getAttribute('data-file-input')
        || explicitOwner.getAttribute('data-input')
        || explicitOwner.getAttribute('aria-controls');
      const referencedInput = reference ? document.getElementById(reference) : null;
      if (isFileInput(referencedInput)) return referencedInput;
    }

    let container = value;
    while (container && container !== document.documentElement) {
      const containedInputs = Array.from(container.querySelectorAll('input[type="file"]'))
        .filter(isFileInput);
      if (containedInputs.length === 1) return containedInputs[0];
      if (containedInputs.length > 1) break;
      container = container.parentElement;
    }

    const inputs = allFileInputs();
    return inputs.length === 1 ? inputs[0] : null;
  }

  function captureMultiFiles(input, sourceFiles) {
    const target = multiFileTarget(input);
    const files = Array.from(sourceFiles || []);
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (
      !target
      || files.length === 0
      || files.length > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET}
      || totalBytes <= 0
      || totalBytes > MAX_BYTES
    ) {
      report('MULTI_FILE_SELECTION_INVALID');
      return;
    }
    window.parent.postMessage(
      {
        marker: MULTI_FILE_MARKER,
        type: 'files-selected',
        target,
        merge: input.multiple || input.hasAttribute('webkitdirectory'),
        files: files.map((file) => ({
          name: file.name,
          type: file.type || '',
          lastModified: file.lastModified,
          webkitRelativePath: typeof file.webkitRelativePath === 'string'
            ? file.webkitRelativePath
            : '',
          blob: file,
        })),
      },
      '*',
    );
  }

  function captureMultiFileSelection(event) {
    if (!MULTI_FILE_MODE || READ_ONLY || !event.isTrusted || !isFileInput(event.target)) return;
    captureMultiFiles(event.target, event.target.files);
  }

  function captureMultiFileDrop(event) {
    if (!MULTI_FILE_MODE || READ_ONLY || !event.isTrusted) return;
    const transfer = event.dataTransfer;
    if (!transfer || transfer.files.length === 0) return;
    const input = fileInputForDropTarget(event.target);
    if (!input) {
      report('MULTI_FILE_DROP_TARGET_NOT_FOUND');
      return;
    }
    // Observe the trusted drop without cancelling it. The dashboard's own
    // capture/bubble handlers still receive the original DataTransfer.
    captureMultiFiles(input, transfer.files);
  }

  function matchesMultiFileTarget(input, target) {
    const inputs = allFileInputs();
    if (target.id) return uniqueInputText(inputs, input, 'id')?.normalize('NFC') === target.id;
    if (target.name) return uniqueInputText(inputs, input, 'name')?.normalize('NFC') === target.name;
    return inputs[target.index] === input;
  }

  async function waitForMultiFileInput(target) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const input = allFileInputs().find((candidate) => matchesMultiFileTarget(candidate, target));
      if (input) return input;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  }

  function restoreRelativePath(file, value) {
    if (!value) return;
    try {
      Object.defineProperty(file, 'webkitRelativePath', {
        configurable: true,
        enumerable: true,
        value,
      });
    } catch {}
  }

  function validRestoreId(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function waitForDashboardPaint() {
    return new Promise((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        window.clearTimeout(fallbackTimer);
        resolve();
      };
      const fallbackTimer = window.setTimeout(finish, 500);
      try {
        window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
      } catch {
        finish();
      }
    });
  }

  function waitForDashboardProcessing(trigger, restoreId, fileCount, onDomQuiet) {
    return new Promise((resolve, reject) => {
      const root = document.body || document.documentElement;
      let completed = false;
      let triggerCompleted = false;
      let explicitReady = false;
      let domQuiet = false;
      let domQuietReported = false;
      let quietTimer = 0;

      const cleanup = () => {
        observer.disconnect();
        window.removeEventListener(RESTORE_READY_EVENT, handleExplicitReady);
        if (quietTimer) window.clearTimeout(quietTimer);
        window.clearTimeout(timeoutTimer);
      };
      const complete = (confirmation) => {
        if (completed) return;
        completed = true;
        cleanup();
        if (confirmation === 'event' && window.__ktsDashboardUsage) window.__ktsDashboardUsage.record('data_loaded');
        resolve(confirmation);
      };
      const confirmAfterPaint = () => {
        void waitForDashboardPaint().then(() => {
          if (completed) return;
          complete('event');
        });
      };
      const reportDomQuietIfReady = () => {
        if (!triggerCompleted || !domQuiet || domQuietReported || completed) return;
        domQuietReported = true;
        try { onDomQuiet(); } catch {}
      };
      const confirmIfReady = () => {
        if (!triggerCompleted || completed) return;
        if (explicitReady) {
          confirmAfterPaint();
        }
      };
      const handleExplicitReady = (event) => {
        const detail = event && event.detail;
        if (!detail || detail.restoreId !== restoreId) return;
        explicitReady = true;
        confirmIfReady();
      };
      const observer = new MutationObserver(() => {
        domQuiet = false;
        if (quietTimer) window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(() => {
          domQuiet = true;
          reportDomQuietIfReady();
        }, RESTORE_DOM_QUIET_MS);
      });
      const timeoutTimer = window.setTimeout(() => complete(null), RESTORE_TIMEOUT_MS);

      window.addEventListener(RESTORE_READY_EVENT, handleExplicitReady);
      observer.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });

      try {
        window.dispatchEvent(new CustomEvent(RESTORE_START_EVENT, {
          detail: { restoreId, fileCount },
        }));
        installLegacyReadyHook(restoreId);
        Promise.resolve(trigger()).then(() => {
          triggerCompleted = true;
          confirmIfReady();
          reportDomQuietIfReady();
        }).catch((error) => {
          if (!completed) {
            completed = true;
            cleanup();
          }
          reject(error);
        });
      } catch (error) {
        if (!completed) {
          completed = true;
          cleanup();
        }
        reject(error);
      }
    });
  }

  async function installMultiFileSnapshot(targets, restoreId) {
    if (multiFileRestorePending) return;
    multiFileRestorePending = true;
    let installedFiles = 0;
    try {
      if (
        !validRestoreId(restoreId)
        || !Array.isArray(targets)
        || targets.length === 0
        || targets.length > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS}
      ) {
        throw new Error('invalid targets');
      }
      const restoredInputs = [];
      for (const entry of targets) {
        if (!entry || typeof entry !== 'object' || !entry.target || !Array.isArray(entry.files)) {
          throw new Error('invalid target');
        }
        const input = await waitForMultiFileInput(entry.target);
        if (!input) throw new Error('missing input');
        const transfer = new DataTransfer();
        for (const candidate of entry.files) {
          const name = candidate && typeof candidate.name === 'string' ? candidate.name : '';
          const blob = candidate && candidate.blob;
          if (!name || !(blob instanceof Blob) || blob.size <= 0 || blob.size > MAX_BYTES) {
            throw new Error('invalid file');
          }
          const type = candidate && typeof candidate.type === 'string' ? candidate.type : '';
          const lastModified = candidate && Number.isSafeInteger(candidate.lastModified)
            && candidate.lastModified >= 0
            ? candidate.lastModified
            : 0;
          const relativePath = candidate && typeof candidate.webkitRelativePath === 'string'
            ? candidate.webkitRelativePath
            : '';
          const restoredFile = new File([blob], name, { type, lastModified });
          restoreRelativePath(restoredFile, relativePath);
          transfer.items.add(restoredFile);
          installedFiles += 1;
        }
        input.files = transfer.files;
        entry.files.forEach((candidate, index) => {
          const installedFile = input.files && input.files[index];
          if (installedFile && candidate && typeof candidate.webkitRelativePath === 'string') {
            restoreRelativePath(installedFile, candidate.webkitRelativePath);
          }
        });
        restoredInputs.push(input);
      }
      window.parent.postMessage(
        {
          marker: MULTI_FILE_MARKER,
          type: 'files-processing',
          restoreId,
          fileCount: installedFiles,
        },
        '*',
      );
      const confirmation = await waitForDashboardProcessing(() => {
        return restoredInputs.reduce((chain, input, index) => chain.then(async () => {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (index + 1 < restoredInputs.length) {
            await new Promise((resolve) => {
              window.setTimeout(resolve, MULTI_INPUT_DISPATCH_GAP_MS);
            });
          }
        }), Promise.resolve());
      }, restoreId, installedFiles, () => {
        window.parent.postMessage(
          {
            marker: MULTI_FILE_MARKER,
            type: 'files-processing-unconfirmed',
            restoreId,
            fileCount: installedFiles,
          },
          '*',
        );
      });
      lockFileInputs();
      window.parent.postMessage(
        {
          marker: MULTI_FILE_MARKER,
          type: confirmation ? 'files-installed' : 'files-delivered-unconfirmed',
          restoreId,
          fileCount: installedFiles,
          confirmation,
        },
        '*',
      );
    } catch {
      report('MULTI_FILE_INSTALL_FAILED', { restoreId });
    } finally {
      multiFileRestorePending = false;
    }
  }

  if (MULTI_FILE_MODE && !READ_ONLY) {
    document.addEventListener('change', captureMultiFileSelection, true);
    document.addEventListener('drop', captureMultiFileDrop, true);
  }

`;
}
