import { validDashboardKey } from './dashboardPermissions';

/** Versioned originals; never resolve a user-supplied filename or filesystem path. */
export const DASHBOARD_INSTRUCTIONS = {
  'personal-sales': {
    title: 'Личный дашборд продаж', version: 'v34', pages: 15,
    filename: 'personal-sales-v34.pdf',
    downloadName: 'Инструкция_Личный_дашборд_продаж_v34.pdf',
    video: {
      filename: 'personal-sales-v34.mp4',
      downloadName: 'Видеообзор_КРАТКИЙ_Личный_дашборд_продаж_v34.mp4',
      duration: '3:27',
    },
  },
  'sales-analytics': {
    title: 'Аналитика продаж', version: 'v94', pages: 33,
    filename: 'sales-analytics-v94.pdf',
    downloadName: 'Инструкция_Аналитика_продаж_v94.pdf',
    video: {
      filename: 'sales-analytics-v94.mp4',
      downloadName: 'Видеообзор_КРАТКИЙ_Аналитика_продаж_v94.mp4',
      duration: '5:23',
    },
  },
} as const;

export type DashboardInstructionKind = keyof typeof DASHBOARD_INSTRUCTIONS;
export type DashboardInstructionFormat = 'pdf' | 'video';

export function resolveDashboardInstruction(kind: string, dashboardKey: string) {
  if (kind === 'personal-sales' && ['manager:development', 'manager:support'].includes(dashboardKey)) {
    return DASHBOARD_INSTRUCTIONS[kind];
  }
  if (kind === 'sales-analytics' && validDashboardKey(dashboardKey) && dashboardKey.startsWith('top:')) {
    return DASHBOARD_INSTRUCTIONS[kind];
  }
  return null;
}

export const DASHBOARD_INSTRUCTION_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
