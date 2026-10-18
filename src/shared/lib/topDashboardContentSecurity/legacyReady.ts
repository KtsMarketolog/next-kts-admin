// Recognition is deliberately limited to the reviewed synchronous legacy contract.
export type TopDashboardLegacyReadyFunction = 'loadState';

function extractClassicFunctionBody(source: string, functionName: string): string | null {
  const declaration = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`, 'u').exec(source);
  if (!declaration) return null;
  const openingBrace = source.indexOf('{', declaration.index + declaration[0].length);
  if (openingBrace === -1) return null;

  let depth = 1;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? '';
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
  }
  return null;
}

function maskJavaScriptCommentsAndStrings(source: string): string {
  let output = '';
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? '';
    const masked = character === '\n' || character === '\r' ? character : ' ';
    if (lineComment) {
      output += masked;
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      output += masked;
      if (character === '*' && next === '/') {
        output += ' ';
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += masked;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      output += '  ';
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      output += '  ';
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      output += ' ';
      quote = character;
      continue;
    }
    output += character;
  }
  return output;
}

function hasStandaloneFinalRenderCall(source: string): boolean {
  return /(?:^|[;}])\s*render\s*\(\s*\)\s*;\s*$/u.test(source);
}


export function detectTopDashboardLegacyReadyFunction(
  htmlContent: string,
): TopDashboardLegacyReadyFunction | null {
  const isStrategicOverview = /СТРАТЕГИЧЕСКИЙ\s+ОБЗОР\s+ГРУППЫ/iu.test(htmlContent);
  const loadStateBody = extractClassicFunctionBody(htmlContent, 'loadState');
  const openFileBody = extractClassicFunctionBody(htmlContent, 'openFile');
  const loadStateCode = loadStateBody
    ? maskJavaScriptCommentsAndStrings(loadStateBody).trim()
    : '';
  const openFileCode = openFileBody
    ? maskJavaScriptCommentsAndStrings(openFileBody)
    : '';
  const hasSynchronousLoadState = hasStandaloneFinalRenderCall(loadStateCode);
  const opensThroughLoadState = /\bloadState\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*;/u.test(openFileCode);
  return isStrategicOverview && hasSynchronousLoadState && opensThroughLoadState
    ? 'loadState'
    : null;
}
