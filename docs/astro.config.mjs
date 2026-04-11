// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://cyberbase.wiki', // Update with actual domain
	integrations: [
		starlight({
			title: 'Cyberbase',
			description: 'A contributable cyber knowledge wiki',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/cybersader/cyberbase' },
			],
			editLink: {
				baseUrl: 'https://github.com/cybersader/cyberbase/edit/main/',
			},
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Welcome', slug: 'index' },
					],
				},
				{
					label: 'Knowledge Base',
					autogenerate: { directory: 'kb' },
				},
			],
			// Prepare for customization
			customCss: [
				'./src/styles/custom.css',
			],
		}),
	],
});
