export const DSH_VERSION = '0.1.0-rc.6';
export const APP_NAME = 'ADHD One';
export const APP_SUBTITLE = 'Desktop for DeepSeek Harness';
export const PROJECT_URL = 'https://github.com/xydadada/adhd-one';

export type RuntimeState = 'idle' | 'preparing' | 'starting' | 'ready' | 'stopping' | 'updating' | 'failed';
export type RuntimeSlot = 'bundled' | 'A' | 'B';

export interface RuntimeSnapshot {
  state: RuntimeState;
  generation: number;
  runtimeVersion: string;
  runtimeSlot: RuntimeSlot;
  pid?: number | undefined;
  url?: string | undefined;
  error?: { code: string; message: string } | undefined;
}

export type UpdateTarget = 'app' | 'runtime';
export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'verified' | 'installing' | 'failed';
export interface UpdateSnapshot {
  target: UpdateTarget;
  state: UpdateState;
  version?: string;
  progress?: number;
  error?: { code: string; message: string } | undefined;
}

export interface DoctorCheck {
  id: string;
  status: 'pass' | 'warning' | 'fail' | 'skipped';
  code?: string;
  summary: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  appVersion: string;
  runtimeVersion: string;
  platform: string;
  mode: 'quick' | 'deep';
  checks: DoctorCheck[];
}

export interface DoctorProgress {
  phase: string;
  message: string;
  percent?: number;
}

export interface AppSnapshot {
  appVersion: string;
  runtime: RuntimeSnapshot;
  workspace?: string | undefined;
  paths: { data: string; logs: string; dshHome: string };
}

export interface AppSettings {
  schemaVersion: 2;
  locale: 'zh-CN' | 'en-US';
  workspace?: string | undefined;
  preferredPort: number;
  appChannel: 'stable' | 'preview';
  runtimeChannel: 'stable' | 'preview';
  closeToTrayExplained: boolean;
  migration: { v1Imported: boolean; legacyDshPrompted: boolean };
}

export interface RuntimeManifestV1 {
  schemaVersion: 1;
  channel: 'stable' | 'preview';
  generatedAt: string;
  minAppVersion: string;
  platform: 'win32';
  arch: 'x64';
  runtime: {
    version: string;
    dshPackage: '@deepseek-ai/dsh';
    dshIntegrity: string;
    nodeVersion: string;
    pnpmVersion: string;
    protocolCompatibility: string;
  };
  asset: { name: string; url: string; size: number; sha256: string };
  source: { upstreamRepo: 'deepseek-ai/DeepSeek-Harness'; npmPublishedAt: string; upstreamCommit?: string };
  attestation: { repository: 'xydadada/adhd-one'; workflow: string; ref: string; subjectDigest: string };
  notesUrl?: string;
}
