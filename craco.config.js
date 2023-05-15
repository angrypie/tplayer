const babel = {
	plugins: [
		['styled-jsx/babel'],
		['babel-plugin-root-import', { rootPathSuffix: 'src' }],
		['@babel/plugin-proposal-object-rest-spread'],
	],
}

// const webpack = {devServer: { port: 80, allowedHosts: ['domain.angrypie.dev']}}

module.exports = {
	babel,
	// devServer: webpack.devServer,
}

