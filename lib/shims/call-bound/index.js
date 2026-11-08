'use strict';

var GetIntrinsic;
try {
	GetIntrinsic = require('get-intrinsic');
} catch (_) {
	GetIntrinsic = function getIntrinsicFallback(name, allowMissing) {
		var clean = String(name || '').replace(/^%|%$/g, '');
		var parts = clean.split('.');
		var curr = typeof globalThis !== 'undefined' ? globalThis : global;
		for (var i = 0; i < parts.length; i++) {
			if (curr == null) break;
			curr = curr[parts[i]];
		}
		if (!curr && !allowMissing) {
			throw new TypeError('intrinsic ' + name + ' not found');
		}
		return curr;
	};
}

var callBindBasic;
try {
	callBindBasic = require('call-bind-apply-helpers');
} catch (_) {
	try {
		callBindBasic = require('../call-bind-apply-helpers');
	} catch (__) {
		callBindBasic = function (args) {
			var fn = args[0];
			return Function.prototype.call.bind(fn);
		};
	}
}

var $indexOf;
try {
	$indexOf = callBindBasic([GetIntrinsic('%String.prototype.indexOf%')]);
} catch (_) {
	$indexOf = function (str, search) {
		return String.prototype.indexOf.call(str, search);
	};
}

module.exports = function callBoundIntrinsic(name, allowMissing) {
	var intrinsic = GetIntrinsic(name, !!allowMissing);
	if (typeof intrinsic === 'function' && $indexOf(name, '.prototype.') > -1) {
		return callBindBasic([intrinsic]);
	}
	return intrinsic;
};
