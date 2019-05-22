const http = require('http');
const timestamp = require("console-timestamp");
const filenamify = require('filenamify');
const fs = require('fs-extra');
const md5 = require('md5');
const fetch = require("node-fetch");
const authen = require('./authen.json');
const authenBrowser = require('./authenBrowser.json');
const async = require('async');
const util = require('util');


let LibreTextsFunctions = {
	authenticatedFetch: authenticatedFetch,
	getSubpages: getSubpages,
	getSubpagesAlternate: getSubpagesAlternate,
	clarifySubdomain: clarifySubdomain,
	encodeHTML: encodeHTML,
	decodeHTML: decodeHTML,
	authenticate: authenticate,
	addLinks: addLinks,
	extractSubdomain: extractSubdomain,
};

async function authenticatedFetch(path, api, subdomain, username) {
	let isNumber;
	if (!isNaN(path)) {
		path = parseInt(path);
		isNumber = true;
	}
	if (path === 'home') {
		isNumber = true;
	}
	if (!subdomain) {
		console.error(`Invalid subdomain ${subdomain}`);
		return false;
	}
	if (!username) {
		return await fetch(`https://${subdomain}.libretexts.org/@api/deki/pages/${isNumber ? '' : '='}${encodeURIComponent(encodeURIComponent(path))}/${api}`, {
			headers: {
				'X-Requested-With': 'XMLHttpRequest',
				'x-deki-token': authenBrowser[subdomain]
			}
		});
	}
	else {
		const user = "=" + username;
		const crypto = require('crypto');
		const hmac = crypto.createHmac('sha256', authen[subdomain].secret);
		const epoch = Math.floor(Date.now() / 1000);
		hmac.update(`${authen[subdomain].key}${epoch}${user}`);
		const hash = hmac.digest('hex');
		let token = `${authen[subdomain].key}_${epoch}_${user}_${hash}`;
		
		return await fetch(`https://${subdomain}.libretexts.org/@api/deki/pages/${isNumber ? '' : '='}${encodeURIComponent(encodeURIComponent(path))}/${api}`,
			{headers: {'x-deki-token': token}});
	}
}

async function getSubpagesAlternate(rootURL, username, options) {
	let origin = rootURL.split("/")[2].split(".");
	const subdomain = origin[0];
	let timer = 0;
	let numpages = setInterval(() => {
		if (options.socket) { //not quite working yet
			timer += Math.round(Math.random()*500);
			options.socket.emit('setState', {state: 'getSubpages', numPages: timer});
		}
	}, 1000);
	let pages = await fetch(`https://${subdomain}.libretexts.org/@api/deki/pages?authenticate=true&dream.out.format=json`, {
		headers: {
			'x-deki-token': authenticate(username, subdomain)
		}
	});
	if (!pages.ok) {
		console.error(await pages.text());
		return;
	}
	pages = await pages.text();
	pages = pages.match(/(?<="uri.ui":").*?(?=")/g);
	clearInterval(numpages);
	return pages
}

async function getSubpages(rootURL, username, options = {}) {
	let origin = rootURL.split("/")[2].split(".");
	const subdomain = origin[0];
	if (rootURL.match(/\.libretexts\.org\/?$/)) { //at homepage
		rootURL = `https://${subdomain}.libretexts.org/home`;
		options['depth'] = 0;
		console.log(`Working on root ${subdomain}`);
		if (options.flat)
			return await getSubpagesAlternate(rootURL, username, options);
	}
	let count = 0;
	
	origin = rootURL.split("/").splice(0, 3).join('/');
	let path = rootURL.split('/').splice(3).join('/');
	if (options['depth'] !== 0)
		options['depth'] = (rootURL.split('/').length - 2 || 0);
	console.log(`Initial Depth: ${options.depth}`);
	if (options.depth !== undefined)
		options.depth = options.depth + 1;
	
	let {info, contents, properties, tags} = await getPage(path, username, {
		getDetails: options.getDetails,
		getContents: options.getContents
	});
	let pages = await authenticatedFetch(path, 'subpages?dream.out.format=json', subdomain, username);
	pages = await pages.json();
	
	let contentsArray = [{url: rootURL, id: info['@id'], contents: contents}];
	let flatArray = [rootURL];
	let numpages = setInterval(() => {
		if (options.socket) { //not quite working yet
			options.socket.emit('setState', {state: 'getSubpages', numPages: flatArray.length});
		}
	}, 1000);
	let result = {
		title: info.title,
		url: rootURL,
		tags: tags,
		properties: properties,
		subdomain: subdomain,
		children: await subpageCallback(pages, options),
		id: info['@id'],
	};
	clearInterval(numpages);
	if (options.getContents)
		return [result, contentsArray];
	else if (options.flat)
		return flatArray;
	else
		return result;
	
	
	async function subpageCallback(info, options = {}) {
		let subpageArray = info["page.subpage"];
		const result = [];
		const promiseArray = [];
		
		async function subpage(subpage, index, options = {}) {
			let url = subpage["uri.ui"];
			let path = subpage.path["#text"];
			const hasChildren = subpage["@subpages"] === "true";
			let children = hasChildren ? undefined : [];
			let {contents, properties, tags} = await getPage(path, username, options);
			if (hasChildren) { //recurse down
				children = await authenticatedFetch(path, 'subpages?dream.out.format=json', subdomain, username);
				children = await children.json();
				children = await subpageCallback(children, !tags.includes('coverpage:yes') && options.delay ? {
					delay: options.delay,
					depth: options.depth,
					getDetails: options.getDetails,
					getContents: options.getContents
				} : {getDetails: options.getDetails, getContents: options.getContents});
			}
			contentsArray.push({url: url, id: subpage['@id'], contents: contents});
			result[index] = {
				title: subpage.title,
				url: url,
				tags: tags,
				properties: properties,
				subdomain: subdomain,
				children: children,
				id: subpage['@id'],
				relativePath: encodeURIComponent(decodeURIComponent(url).replace(decodeURIComponent(rootURL) + '/', ''))
			};
		}
		
		if (subpageArray) {
			if (!subpageArray.length) {
				subpageArray = [subpageArray];
			}
			for (let i = 0; i < subpageArray.length; i++) {
				flatArray.push(subpageArray[i]["uri.ui"]);
				if (options.delay && options.depth < 2) {
					console.log(`Delay ${options.depth} ${subpageArray[i]["uri.ui"]}`);
					await subpage(subpageArray[i], i, {
						delay: options.delay,
						depth: options.depth + 1,
						getContents: options.getContents
					});
				}
				else {
					// console.log(subpageArray[i]["uri.ui"]);
					promiseArray[i] = subpage(subpageArray[i], i, {getContents: options.getContents});
				}
			}
			await Promise.all(promiseArray);
			return result;
		}
		return {};
	}
	
	async function getPage(path, username, options) {
		let info, contents, tags, properties;
		
		if (!options.flat)
			info = authenticatedFetch(path, 'info?dream.out.format=json', subdomain, username);
		if (options.getDetails || options.getContents) {
			// properties = authenticatedFetch(path, 'properties?dream.out.format=json', subdomain, username);
			tags = authenticatedFetch(path, 'tags?dream.out.format=json', subdomain, username);
		}
		if (options.getContents) {
			contents = authenticatedFetch(path, 'contents?dream.out.format=json', subdomain, username);
		}
		
		info = await info;
		// properties = await properties;
		tags = await tags;
		contents = await contents;
		
		if (info)
			info = await info.json();
		if (contents)
			contents = await contents.text();
		/*		if (properties && (properties = await properties.json()) && properties['@count'] !== '0' && properties.property) {
					properties = properties.property.length ? properties.property : [properties.property]
				}
				else {
					properties = [];
				}*/
		if (tags && (tags = await tags.json()) && tags['@count'] !== '0' && tags.tag) {
			tags = tags.tag.length ? tags.tag : [tags.tag];
			tags = tags.map((elem) => elem.title);
		}
		else {
			tags = [];
		}
		
		return {info: info, tags: tags, properties: properties, contents: contents}
	}
}

function clarifySubdomain(url) {
	url = decodeURIComponent(url);
	url = url.replace('https://español.libretexts.org', 'https://espanol.libretexts.org');
	return url;
}

function decodeHTML(content) {
	let ret = content.replace(/&gt;/g, '>');
	ret = ret.replace(/&lt;/g, '<');
	ret = ret.replace(/&quot;/g, '"');
	ret = ret.replace(/&apos;/g, "'");
	ret = ret.replace(/&amp;/g, '&');
	return ret;
}

function encodeHTML(content) {
	let ret = content;
	ret = ret.replace(/&/g, '&amp;');
	ret = ret.replace(/>/g, '&gt;');
	ret = ret.replace(/</g, '&lt;');
	ret = ret.replace(/"/g, '&quot;');
	ret = ret.replace(/'/g, "&apos;");
	return ret;
}

function authenticate(username, subdomain) {
	const user = "=" + username;
	const crypto = require('crypto');
	const hmac = crypto.createHmac('sha256', authen[subdomain].secret);
	const epoch = Math.floor(Date.now() / 1000);
	hmac.update(`${authen[subdomain].key}${epoch}${user}`);
	const hash = hmac.digest('hex');
	return `${authen[subdomain].key}_${epoch}_${user}_${hash}`;
}

function addLinks(current) {
	let array = [current.url];
	let children = current.children;
	if (children && children.length) {
		children.forEach((child) => {
			array = array.concat(addLinks(child));
		});
	}
	return array;
}

function extractSubdomain(url) {
	let origin = url.split("/")[2].split(".");
	const subdomain = origin[0];
	return subdomain;
}

module.exports = LibreTextsFunctions;