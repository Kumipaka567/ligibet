export interface WithdrawalPopup {
  title: string;
  message: string;
  type: string;
}

/** Preserve configured notices on rejected requests as well as accepted ones. */
export function withdrawalErrorPopup(error: unknown): WithdrawalPopup {
  const failure = error as { message?: unknown; popup?: Partial<WithdrawalPopup> } | null;
  const popup = typeof failure === 'object' && failure !== null ? failure.popup : undefined;
  const text = (value: unknown): string => typeof value === 'string' ? value : '';
  const message = text(popup?.message) || text(failure?.message) || text(error) || 'Withdrawal could not be completed.';
  return {
    title: text(popup?.title) || (/insufficient|balance/i.test(message) ? 'Insufficient Funds' : 'Withdrawal Notice'),
    message,
    type: text(popup?.type) || 'rejected'
  };
}
