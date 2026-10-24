// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

export default defineConfig({
  site: 'https://docs.anywallet.tech',
  // The Introduction is the home page; keep the old address working.
  redirects: { '/getting-started/introduction/': '/' },
  integrations: [
    starlight({
      title: 'Any Wallet Kit',
      description:
        'Developer docs for Any Wallet Kit — the open multichain wallet SDK: one seed, every chain, a pluggable signer, protocol modules for swaps, bridges, staking and lending.',
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ultratestbro/anywalletkit' },
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
      // /llms.txt, /llms-full.txt and /llms-small.txt: the docs as plain Markdown for AI agents.
      plugins: [
        // API reference: TypeDoc over every package's public entry point, written to
        // src/content/docs/api at build time (generated, not committed).
        starlightTypeDoc({
          entryPoints: ['../../packages/*'],
          output: 'api',
          sidebar: { label: 'API reference', collapsed: true },
          typeDoc: {
            entryPointStrategy: 'packages',
            packageOptions: {
              entryPoints: ['src/index.ts'],
              excludePrivate: true,
              excludeInternal: true,
              excludeExternals: true,
            },
            excludePrivate: true,
            excludeInternal: true,
            excludeExternals: true,
            validation: { notExported: false, invalidLink: false },
            logLevel: 'Error',
          },
        }),
        starlightLlmsTxt({
          projectName: 'Any Wallet Kit',
          description:
            'Open multichain wallet SDK in TypeScript: one seed for EVM, Solana, TON, Tron, Bitcoin, NEAR and Zcash accounts, a pluggable signer, safety policies, and protocol modules for swaps, bridges, staking and lending. Package names use the @anywalletkit npm scope; the packages are not on npm yet. Source: https://github.com/ultratestbro/anywalletkit.',
          // llms-small.txt is the guides only; llms-full.txt has the guides first and
          // the API reference after them; llms-api-reference.txt is the API alone.
          exclude: ['api/**'],
          demote: ['api/**'],
          customSets: [
            { label: 'API reference', paths: ['api/**'], description: 'every exported class, function and type of the @anywalletkit packages, generated from the source' },
          ],
        }),
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
        { label: 'Build a wallet', items: [{ autogenerate: { directory: 'build-a-wallet' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        typeDocSidebarGroup,
      ],
    }),
  ],
});
