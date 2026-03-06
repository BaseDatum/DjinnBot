/**
 * Authentication settings panel — OIDC providers, API keys, and 2FA management.
 * Displayed as a tab within the Settings page.
 */

import { useAuth } from '@/hooks/useAuth';
import { OIDCProviderSettings } from './OIDCProviderSettings';
import { APIKeySettings } from './APIKeySettings';
import { TwoFactorSettings } from './TwoFactorSettings';

export function AuthSettings() {
  const { user } = useAuth();

  return (
    <div className="space-y-8">
      {/* 2FA Section — always visible for authenticated users */}
      <TwoFactorSettings />

      {/* API Keys */}
      <APIKeySettings />

      {/* OIDC Providers — admin only */}
      {user?.isAdmin && <OIDCProviderSettings />}
    </div>
  );
}
