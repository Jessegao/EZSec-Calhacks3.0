"use strict";

// initalize required modules

// require standard modules
const fs = require('fs');

// require remote modules
const express = require("express");
const bodyParser = require("body-parser");

//var snmp = require('snmpjs');

// require local modules
const chatbot_actions = require('./chatbot_actions');

// create server instance
const server = require('express-async-await')(express());

// set up server-level middleware
server.use(bodyParser.json());

server.use(function (req, res, next) {
  console.log(`${req.method} called at starting epoch ${Date.now()}`);
  next();
});

server.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).send(`Internal server error: ${err.message}`);
});

// used to prevent use on untested sources
var supportedSources = [
  'google',
  'facebook',
  'slack',
  'slack_testbot',
  'spark'
];

// parses req for basic info, for sake of shorter json paths and re-usability
function retrieveBasicInfo(req) {
  let results = req.body.result;
  let ogReq = req.body.originalRequest;

  var contextObj = {};
  results.contexts.forEach(con => contextObj[con.name] = con.parameters);

  return {
    source: ogReq ? ogReq.source || undefined : undefined,
    action: results.action,
    parameters: results.parameters,
    contexts: contextObj,
    originalReq: ogReq
  }
}

// set-up webhook
server.post("/chatbot", async function(req, res, next) {
  let basicInfo = retrieveBasicInfo(req);

  if (supportedSources.includes(basicInfo.source)) {
    // process via action map
    console.log(`Executing action ${basicInfo.action} for source ${basicInfo.source}`);
    await chatbot_actions[basicInfo.action](basicInfo, res);
  } else {
    // source not supported
    console.log(`Error: source ${basicInfo.source} is not supported!`);
    return res.status(500).send(`Error: source ${basicInfo.source} is not supported!`);
  }
});

// start listening
server.listen(process.env.PORT || 8080, () => console.log(`Server listening on port ${process.env.PORT}`));

/*var trapd = snmp.createTrapListener();

trapd.on('trap', function(msg){
  //result.push(msg);
  var now = new Date();
  console.log("Trap Received " + now);
  console.log(util.inspect(snmp.message.serializer(msg)['pdu'], false, null));
  console.log(result.length);
});

trapd.bind({family: 'udp4', port: process.env.PORT}, () => console.log('smnp server started'));*/
