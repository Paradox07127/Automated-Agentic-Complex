// The system permissions the shell can report, request and open settings for.
export type PermissionKind =
  | 'accessibility'
  | 'screenRecording'
  | 'microphone'
  | 'automation'
  | 'inputMonitoring'
  | 'notifications';

export type PermissionState = 'granted' | 'denied' | 'notDetermined' | 'unsupported';

/** System settings panes the UI can open: every permission plus login items. */
export type SystemSettingsPane = PermissionKind | 'loginItems';
