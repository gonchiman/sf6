/** Only normalized rendered-state evidence may leave the diagnostic observer. */
export interface DistributionPageObservationSnapshot {
  authenticationEvidence: 'logout-control' | 'login-control' | 'conflicting-controls' | 'no-control' | null
  loginRequiredHeading: boolean | null
  rankingReadable: boolean | null
}

export function distributionPageObservationSnapshot(authenticationEvidence: unknown, loginRequiredHeading: unknown,
  rankingReadable: boolean | null): DistributionPageObservationSnapshot {
  return {
    authenticationEvidence: authenticationEvidence === 'logout-control' || authenticationEvidence === 'login-control'
      || authenticationEvidence === 'conflicting-controls' || authenticationEvidence === 'no-control' ? authenticationEvidence : null,
    loginRequiredHeading: typeof loginRequiredHeading === 'boolean' ? loginRequiredHeading : null,
    rankingReadable,
  }
}
