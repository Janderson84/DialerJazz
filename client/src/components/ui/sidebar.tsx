import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { navMain, navManagement } from '@/components/nav-items';
import { useActiveCampaign } from '@/hooks/useActiveCampaign';

import {
  ChevronRight,
  ChevronsUpDown,
  LogOut,
  Settings,
  HelpCircle,
  SquareDashedBottomCode,
  Users,
  RefreshCcwDot,
  CircleCheck,
  CircleX,
  ChevronsLeftRightEllipsis,
} from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';

// This is help trigger for the help button in the footer
import { HelpDialogTrigger } from '@/components/HelpDialogTrigger';

export function AppSidebar() {
  const location = useLocation();
  const { user, signOut } = useAuth();
  const { isMobile } = useSidebar();
  const { activeCampaign } = useActiveCampaign();

  const navLink = (item: { title: string; url: string }) => {
    const isActive = location.pathname === item.url || location.pathname === item.url + '/';
    return (
      <SidebarMenuItem key={item.title}>
        <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
          <Link to={item.url}>
            <item.icon />
            <span>{item.title}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  const header = (
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton size="lg" className="!p-1.5">
                <div className="flex items-center gap-2">
                  <img src="/logo.png" alt="The SalesCloser Cold Call Machine" className="h-8 w-auto object-contain" />
                  <span className="text-lg font-semibold text-gray-900 dark:text-white">Cold Call Machine</span>
                </div>
                <ChevronsUpDown className="ml-auto" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right" className="w-56">
              <DropdownMenuItem asChild>
                <Link to="/connectors" className="flex items-center gap-2">
                  <Settings className="h-4 w-4" />
                  <span>Connectors</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={signOut} className="flex items-center gap-2">
                <LogOut className="h-4 w-4" />
                <span>Sign out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      {header}
      <SidebarContent>
        <SidebarGroup label="Overview" className="pl-2">
          <SidebarMenu>{navMain.map((item) => navLink(item))}</SidebarMenu>
        </SidebarGroup>
        <SidebarGroup label="Management" className="pl-2">
          <SidebarMenu>{navManagement.map((item) => navLink(item))}</SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <HelpDialogTrigger />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-sm font-semibold">
                      {(user?.email?.[0] ?? 'U').toUpperCase()}
                    </div>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{user?.email?.split('@')[0] ?? 'Signed out'}</span>
                    </div>
                  </div>
                  <ChevronsUpDown className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right" className="w-56">
                <DropdownMenuLabel className="text-xs text-muted-foreground">{user?.email ?? ''}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings" className="flex items-center gap-2">
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut} className="flex items-center gap-2">
                  <LogOut className="h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
