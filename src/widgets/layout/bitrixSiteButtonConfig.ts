export const BITRIX_SITE_BUTTON_HIDDEN_ROUTE_PREFIXES = ['/admin', '/cabinet', '/login', '/price'];
export const BITRIX_SITE_BUTTON_SCRIPT_ID = 'bitrix-site-button-loader';
export const BITRIX_SITE_BUTTON_LOADER_URL =
  'https://crm.kts-impex.ru/upload/crm/site_button/loader_1_1hr91m.js';

export function shouldHideBitrixSiteButton(pathname: string) {
  return BITRIX_SITE_BUTTON_HIDDEN_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function getBitrixSiteButtonInlineScript() {
  const hiddenPrefixes = JSON.stringify(BITRIX_SITE_BUTTON_HIDDEN_ROUTE_PREFIXES);

  return `
(function(w,d,u,id,hiddenPrefixes){
  var path = w.location.pathname || '/';
  for (var i = 0; i < hiddenPrefixes.length; i += 1) {
    var prefix = hiddenPrefixes[i];
    if (path === prefix || path.indexOf(prefix + '/') === 0) {
      d.documentElement.setAttribute('data-bitrix-site-button', 'hidden');
      return;
    }
  }
  d.documentElement.setAttribute('data-bitrix-site-button', 'visible');
  if (d.getElementById(id)) return;
  var s = d.createElement('script');
  s.id = id;
  s.async = true;
  s.src = u + '?' + (Date.now() / 60000 | 0);
  var h = d.getElementsByTagName('script')[0];
  if (h && h.parentNode) {
    h.parentNode.insertBefore(s, h);
  } else {
    d.head.appendChild(s);
  }
})(window,document,'${BITRIX_SITE_BUTTON_LOADER_URL}','${BITRIX_SITE_BUTTON_SCRIPT_ID}',${hiddenPrefixes});
`;
}
