import { defineConfig, presetIcons, presetWind4 } from 'unocss';

export default defineConfig({
	presets: [
		presetWind4(),
		// Lucide icons as CSS classes: <span class="i-lucide-play"></span>.
		presetIcons({ extraProperties: { display: 'inline-block', 'vertical-align': 'middle' } })
	]
});
