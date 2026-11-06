import { FooterHelp, Link } from '@shopify/polaris';

// Consistent in-app support link across pages — visible help cuts merchant
// confusion and is something App Store reviewers look for.
export default function AppFooter() {
  return (
    <FooterHelp>
      Questions or feedback? Email{' '}
      <Link url="mailto:lg@cursus-ai.co.uk">lg@cursus-ai.co.uk</Link>
    </FooterHelp>
  );
}
