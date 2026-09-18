/** The OAuth usage and profile endpoints need `user:profile`; a `claude
 *  setup-token` credential carries `user:inference` only. */
export function canReadProfile(scopes: string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes("user:profile");
}
