export const DSH_VERSION = '0.1.0-rc.6';
export const APP_NAME = 'ADHD One';
export const APP_SUBTITLE = 'Desktop for DeepSeek Harness';
export const PROJECT_URL = 'https://github.com/xydadada/adhd-one';

export type RuntimeState = 'idle' | 'preparing' | 'starting' | 'ready' | 'stopping' | 'updating' | 'failed';
export type RuntimeSlot = 'bundled' | 'A' | 'B';
export type RuntimeHealth = 'unknown' | 'healthy' | 'unhealthy';
export type SnapshotError = { code: string; message: string };

/** Canonical runtime status contract for the v0.2 public surface. */
export interface RuntimeSnapshotV2 {
  state: RuntimeState;
  generation: number;
  runtimeVersion: string;
  slot: RuntimeSlot;
  health: RuntimeHealth;
  pid?: number | undefined;
  url?: string | undefined;
  restartAttempt: number;
  error?: SnapshotError | undefined;
}

/** Current runtime surface; RuntimeSnapshotV2 is the only public runtime shape. */
export type RuntimeSnapshot = RuntimeSnapshotV2;

export type UpdateTarget = 'app' | 'runtime';
export type UpdateChannel = 'stable' | 'preview';
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'verified' | 'installing' | 'failed';
export type UpdateState = UpdatePhase;

/** Canonical update status contract for app and Runtime updates. */
export interface UpdateSnapshotV2 {
  target: UpdateTarget;
  channel: UpdateChannel;
  phase: UpdatePhase;
  currentVersion: string;
  candidateVersion?: string | undefined;
  receivedBytes?: number | undefined;
  totalBytes?: number | undefined;
  canConfirm: boolean;
  canInstall: boolean;
  rollback: boolean;
  error?: SnapshotError | undefined;
}

/** Compatibility name for the canonical update status contract. */
export type UpdateSnapshot = UpdateSnapshotV2;

export interface DoctorCheck {
  id: string;
  status: 'pass' | 'warning' | 'fail' | 'skipped';
  code?: string;
  summary: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export type DoctorCheckV2 = DoctorCheck;

export interface DoctorEvidenceV2 {
  toolCall: boolean;
  toolResult: boolean;
  argumentsParsed: boolean;
  fileVerified: boolean;
  secondTurnConsumed: boolean;
  finalNonce: boolean;
}

/** Canonical Provider Doctor report contract. Values are safe to copy/share. */
export interface DoctorReportV2 {
  schemaVersion: 2;
  generatedAt: string;
  appVersion: string;
  runtimeVersion: string;
  platform: string;
  mode: 'quick' | 'deep';
  checks: DoctorCheckV2[];
  durationMs: number;
  provider?: string | undefined;
  model?: string | undefined;
  endpoint?: string | undefined;
  requestId: string;
  evidence: DoctorEvidenceV2;
}

/** Compatibility projection retained for the pre-V2 Provider Doctor report. */
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
  portable: boolean;
  runtime: RuntimeSnapshot;
  updates: { app: UpdateSnapshotV2; runtime: UpdateSnapshotV2 };
  workspace?: string | undefined;
}

export interface SettingsMigration {
  v1Imported: boolean;
  legacyDshPrompted: boolean;
}

export interface AppSettingsV2 {
  schemaVersion: 2;
  locale: 'zh-CN' | 'en-US';
  workspace?: string | undefined;
  preferredPort: number;
  appChannel: 'stable' | 'preview';
  runtimeChannel: 'stable' | 'preview';
  closeToTrayExplained: boolean;
  migration: SettingsMigration;
}

export interface AppSettingsV3 {
  schemaVersion: 3;
  locale: 'zh-CN' | 'en-US';
  workspace?: string | undefined;
  preferredPort: number;
  appChannel: 'stable' | 'preview';
  runtimeChannel: 'stable' | 'preview';
  closeToTrayExplained: boolean;
  portableDataPath?: string | undefined;
  migration: SettingsMigration;
}

/** Current settings surface; AppSettingsV2 remains available for migration callers. */
export type AppSettings = AppSettingsV3;

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
