// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.anywallet.tech',
  // The Introduction is the home page; keep the old address working.
  redirects: { '/getting-started/introduction/': '/' },
  integrations: [
    starlight({
      title: 'Any Wallet Kit',
      description:
        'Developer docs for Any Wallet Kit — the open multichain wallet SDK: one seed, every chain, protocol modules anyone can contribute.',
      favicon: '/favicon.svg',
      social: [
        { icon: 'x.com', label: 'X', href: 'https://x.com/anywalletkit' },
        { icon: 'telegram', label: 'Telegram', href: 'https://t.me/anywalletkit' },
      ],
      head: [
        // Not announced yet: keep search engines out until the landing links here.
        { tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#06070A' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap',
          },
        },
      ],
      customCss: ['./src/styles/awk.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
        SocialIcons: './src/components/SocialIcons.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          borderRadius: '14px',
          borderColor: 'var(--hl)',
          codeFontFamily: 'var(--mono)',
          uiFontFamily: 'var(--geist)',
          frames: { shadowColor: 'transparent' },
        },
      },
      sidebar: [
        { label: 'Getting started', items: [{ label: 'Introduction', link: '/' }, { autogenerate: { directory: 'getting-started' } }] },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
      ],
    }),
  ],
});
