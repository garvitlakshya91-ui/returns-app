import { FooterHelp, Link } from '@shopify/polaris';

// Consistent in-app support link across pages — visible help cuts merchant
// confusion and is something App Store reviewers look for.
export default function AppFooter() {
  return (
    <FooterHelp>
      Questions or feedback? Email{' '}
      <Link url="mailto:garvitlakshya91@gmail.com">garvitlakshya91@gmail.com</Link>
    </FooterHelp>
  );
}
