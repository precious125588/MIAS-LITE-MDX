'use strict';

var setFunctionLength;
try {
	setFunctionLength = require('set-function-length');
} catch (_) {
	setFunctionLength = function (fn) { return fn; };
}

var $defineProperty;
try {
	$defineProperty = require('es-define-property');
} catch (_) {
	$defineProperty = Object.defineProperty;
}

var callBindBasic;
try {
	callBindBasic = require('call-bind-apply-helpers');
} catch (_) {
	try {
		callBindBasic = require('../call-bind-apply-helpers');
	} catch (__) {
		callBindBasic = function (args) {
			return Function.prototype.call.bind(args[0]);
		};
	}
}

var applyBind;
try {
	applyBind = require('call-bind-apply-helpers/applyBind');
} catch (_) {
	try {
		applyBind = require('../call-bind-apply-helpers/applyBind');
	} catch (__) {
		applyBind = function (args) {
			return Function.prototype.apply.bind(args[0]);
		};
	}
}

module.exports = function callBind(originalFunction) {
	var func = callBindBasic(arguments);
	var adjustedLength = 1 + originalFunction.length - (arguments.length - 1);
	return setFunctionLength(
		func,
		adjustedLength > 0 ? adjustedLength : 0,
		true
	);
};

if ($defineProperty) {
	try {
		$defineProperty(module.exports, 'apply', { value: applyBind });
	} catch (_) {
		module.exports.apply = applyBind;
	}
} else {
	module.exports.apply = applyBind;
}
