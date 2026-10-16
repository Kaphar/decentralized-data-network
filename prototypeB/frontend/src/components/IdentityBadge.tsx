import { Component } from 'solid-js';
import type { IdentityInfo } from '../types';

export interface IdentityBadgeProps {
  pubkey: string;
}

export const IdentityBadge: Component<IdentityBadgeProps> = (props) => {
  const truncate = (s: string) => {
    if (s.length <= 24) return s;
    return s.slice(0, 12) + '...' + s.slice(-12);
  };

  return (
    <div class="identity-badge" title={props.pubkey}>
      {truncate(props.pubkey)}
    </div>
  );
};
