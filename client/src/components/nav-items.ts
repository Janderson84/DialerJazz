import {
  LayoutDashboard,
  Target,
  Users,
  PhoneCall,
  ScrollText,
  Plug,
  Phone,
  Settings,
  UserCog,
} from 'lucide-react';

export interface NavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
}

/** Top group — day-to-day dialing workflow. */
export const navMain: NavItem[] = [
  { title: 'Dashboard', url: '/dashboard', icon: LayoutDashboard },
  { title: 'Campaigns', url: '/campaigns', icon: Target },
  { title: 'Manual Dialer', url: '/dialer', icon: Phone },
];

/** Second group — CRM management pages. */
export const navManagement: NavItem[] = [
  { title: 'Leads', url: '/leads', icon: Users },
  { title: 'Team', url: '/team', icon: UserCog },
  { title: 'Call Logs', url: '/call-logs', icon: ScrollText },
  { title: 'Connectors', url: '/connectors', icon: Plug },
  { title: 'Settings', url: '/settings', icon: Settings },
];
