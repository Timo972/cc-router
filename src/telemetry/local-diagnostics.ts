/** Keep raw exception detail local while giving support a remote correlation key. */
export function reportRuntimeExceptionLocally(error: unknown, diagnosticId: string): void {
  console.error(`[cc-router] Unexpected runtime failure (diagnostic ID: ${diagnosticId})`, error);
}
