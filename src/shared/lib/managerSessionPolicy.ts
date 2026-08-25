export function shouldRevokeManagerSessionsForUpdate(input: {
  passwordChanged: boolean;
  permissionsChanged: boolean;
  activeStateChanged: boolean;
}) {
  return input.passwordChanged || input.permissionsChanged || input.activeStateChanged;
}
