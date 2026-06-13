import { useCallback, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Frame, Navigation, TopBar } from '@shopify/polaris';
import {
  HomeIcon,
  OrderIcon,
  SettingsIcon,
  ChartVerticalIcon,
  NoteIcon,
} from '@shopify/polaris-icons';

export default function AppFrame({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileNavActive, setMobileNavActive] = useState(false);

  const toggleMobileNav = useCallback(
    () => setMobileNavActive((prev) => !prev),
    [],
  );

  const topBar = (
    <TopBar
      showNavigationToggle
      onNavigationToggle={toggleMobileNav}
    />
  );

  const navigation = (
    <Navigation location={location.pathname}>
      <Navigation.Section
        items={[
          {
            label: 'Dashboard',
            icon: HomeIcon,
            onClick: () => navigate('/'),
            selected: location.pathname === '/',
          },
          {
            label: 'Returns',
            icon: OrderIcon,
            onClick: () => navigate('/returns'),
            selected: location.pathname.startsWith('/returns'),
          },
          {
            label: 'Analytics',
            icon: ChartVerticalIcon,
            onClick: () => navigate('/analytics'),
            selected: location.pathname === '/analytics',
          },
          {
            label: 'Policies',
            icon: NoteIcon,
            onClick: () => navigate('/policies'),
            selected: location.pathname === '/policies',
          },
          {
            label: 'Settings',
            icon: SettingsIcon,
            onClick: () => navigate('/settings'),
            selected: location.pathname === '/settings',
          },
        ]}
      />
    </Navigation>
  );

  return (
    <Frame
      topBar={topBar}
      navigation={navigation}
      showMobileNavigation={mobileNavActive}
      onNavigationDismiss={toggleMobileNav}
    >
      {children}
    </Frame>
  );
}
