// Adapted from nikdelvin/liquid-glass (MIT), reduced to one grayscale edge-refraction pass.
// See THIRD_PARTY_NOTICES.md.
type LiquidGlassOptions = {
	width: number;
	height: number;
	depth?: number;
	strength?: number;
};

const svgDataUrl = (source: string) =>
	`data:image/svg+xml,${encodeURIComponent(source)}`;

export function createLiquidGlassFilter({
	width,
	height,
	depth = 7,
	strength = 18,
}: LiquidGlassOptions) {
	const radius = height / 2;
	const edgeDepth = Math.min(
		Math.max(1, depth),
		Math.max(1, Math.floor(Math.min(width, height) / 2) - 1),
	);
	const xInset = Math.ceil((radius / width) * 15);
	const yInset = Math.ceil((radius / height) * 15);
	const map = svgDataUrl(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
		<defs>
			<linearGradient id="x" x1="${xInset}%" x2="${100 - xInset}%">
				<stop stop-color="#f00"/><stop offset="1" stop-color="#000"/>
			</linearGradient>
			<linearGradient id="y" x1="0" x2="0" y1="${yInset}%" y2="${100 - yInset}%">
				<stop stop-color="#0f0"/><stop offset="1" stop-color="#000"/>
			</linearGradient>
		</defs>
		<rect width="${width}" height="${height}" fill="#000080"/>
		<g filter="blur(2px)">
			<rect width="${width}" height="${height}" fill="url(#x)" style="mix-blend-mode:screen"/>
			<rect width="${width}" height="${height}" fill="url(#y)" style="mix-blend-mode:screen"/>
			<rect x="${edgeDepth}" y="${edgeDepth}" width="${width - edgeDepth * 2}" height="${height - edgeDepth * 2}" rx="${radius}" fill="#808080" filter="blur(${edgeDepth}px)"/>
		</g>
	</svg>`);

	const filter = svgDataUrl(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
		<filter id="glass" color-interpolation-filters="sRGB">
			<feImage width="${width}" height="${height}" href="${map}" result="map"/>
			<feDisplacementMap in="SourceGraphic" in2="map" scale="${strength}" xChannelSelector="R" yChannelSelector="G"/>
		</filter>
	</svg>`);

	return `url("${filter}#glass")`;
}
