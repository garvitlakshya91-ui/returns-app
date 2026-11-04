// The "Start a return" theme app extension: Shopify rejects a block whose
// schema is not valid JSON or whose files are missing, and only at deploy
// time. Check the shape here instead.

const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', '..', 'extensions', 'returns-portal');
const read = (...p) => fs.readFileSync(path.join(EXT, ...p), 'utf8');

describe('extensions/returns-portal (theme app extension)', () => {
  it('is declared as a theme extension', () => {
    const toml = read('shopify.extension.toml');
    expect(toml).toMatch(/^type = "theme"$/m);
    expect(toml).toMatch(/^name = ".+"$/m);
  });

  it('has a "Start a return" app block with a valid schema that targets a section', () => {
    const liquid = read('blocks', 'start-return.liquid');
    const schema = JSON.parse(liquid.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
    expect(schema.name).toBe('Start a return');
    expect(schema.target).toBe('section');
    const ids = schema.settings.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['heading', 'text', 'button_label', 'alignment']));
    // Every setting the block uses is declared.
    for (const used of [...liquid.matchAll(/block\.settings\.([a-z_]+)/g)].map((m) => m[1])) {
      expect(ids).toContain(used);
    }
    // The stylesheet it names exists.
    expect(fs.existsSync(path.join(EXT, 'assets', schema.stylesheet))).toBe(true);
  });

  it('links to this shop\'s portal, derived from the myshopify domain, prefilling a logged-in customer\'s email', () => {
    const liquid = read('blocks', 'start-return.liquid');
    expect(liquid).toContain("shop.permanent_domain | split: '.' | first");
    expect(liquid).toContain("'https://app.returnsflow.uk/portal/' | append: shop_slug");
    expect(liquid).toMatch(/if customer[\s\S]*customer\.email \| url_encode/);
    expect(liquid).toContain('{{ block.shopify_attributes }}');
  });

  it('ships a valid default locale file', () => {
    expect(() => JSON.parse(read('locales', 'en.default.json'))).not.toThrow();
  });
});
