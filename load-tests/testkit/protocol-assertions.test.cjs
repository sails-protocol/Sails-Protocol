'use strict';
const assert = require('node:assert/strict');
const { requireNonemptyString, requireResponseDataString } = require('./protocol-assertions.cjs');
assert.equal(requireNonemptyString('id-123','intent ID'),'id-123');
assert.equal(requireResponseDataString({data:{data:{id:'id-123'}}},'id','intent ID'),'id-123');
for (const bad of [null,undefined,'', '  ',0,{},[]]) assert.throws(()=>requireNonemptyString(bad,'intent ID'));
for (const bad of [null,{}, {data:{}}, {data:{data:{id:0}}}, {data:{data:{id:' '}}}]) assert.throws(()=>requireResponseDataString(bad,'id','intent ID'));
console.log('Sails TestKit protocol assertions positive/negative controls PASS');
