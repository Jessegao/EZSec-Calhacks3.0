"use strict";

const Fuse = require('fuse.js');
const dashboard = require('node-meraki-dashboard')(process.env.MERAKI_API_KEY);
const randomColor = require('randomcolor');
const quiche = require('quiche');
const spark = require('ciscospark/env');
const roundTo = require('round-to');
const secConverter = require("seconds-converter");
const bytes = require('bytes');
const dns = require('dns-then');

var orgs, networksArray;

const type2mult = {
  minute: 60,
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60
}

function normalizeSeconds(seconds) {
  var convertedTime = secConverter(seconds, "sec");
  var precision = 1;
  var result;

  if (convertedTime.days)
    result = roundTo(convertedTime.days + convertedTime.hours / 24, precision) + ' days';
  else if (convertedTime.hours)
    result = roundTo(convertedTime.hours + convertedTime.minutes / 60, precision) + ' hours';
  else if (convertedTime.minutes)
    result = roundTo(convertedTime.minutes + convertedTime.seconds / 60, precision) + ' minutes';
  else
    result = convertedTime.seconds + ' seconds';

  return result;
}

function defaultBotErrorHandler(error, res) {
  return res.json({
    speech: JSON.stringify(error),
    displayText: JSON.stringify(error)
  });
}

function fuseSearch(list, keyValue, options) {
  var fuse_options = {
    shouldSort: true,
    threshold: 0.6,
    distance: 100,
    maxPatternLength: 64,
    minMatchCharLength: 1,
    location: 0,
    keys: options.keys,
    id: options.id
  };

  var fuse = new Fuse(list, fuse_options);
  return fuse.search(keyValue)[0];
}

function handleNonSparkResponse(params) {
  var base_json = {
    platform: params.source,
    data: {
      google: {
        richResponse: {
          items: []
        },
      },
      facebook: {},
      slack: {}
    }
  };

  if (params.contextOut)
    base_json.contextOut = params.contextOut;

  // google
  base_json.data.google.richResponse.items.push({
    simpleResponse: {
      textToSpeech: params.speech || "",
    }
  });

  var basicCard = {};
  if (params.text)
    basicCard.formattedText = params.text.replace(/<bold>/g, '**');
  if (params.imageUrl) {
    basicCard.image = {
      url: params.imageUrl,
      accessibilityText: 'random chart'
    }
  }

  base_json.data.google.richResponse.items.push({
    basicCard: basicCard
  });

  // facebook
  if (params.text)
    base_json.data.facebook.text = params.text.replace(/<bold>/g, '*');

  // facebook seems to have a limit on how much text is sent in one message
  // and dialogflow doesn't allow sending images and formatted text at the same time, directly speaking
  /*if (params.imageUrl) {
    if (base_json.data.facebook.text)
      base_json.data.facebook.text += "\n" + params.imageUrl;
    else
      base_json.data.facebook.text = params.imageUrl;
  }*/

  // slack
  if (params.text)
    base_json.data.slack.text = params.text.replace(/<bold>/g, '*');
  if (params.imageUrl) {
    base_json.data.slack.attachments = [
      {
        'text': '',
        'image_url': params.imageUrl
      }
    ];
  }

  return params.res.json(base_json);
}

async function handleSparkResponse(params) {
  var base_json = {
    roomId: params.info.originalReq.data.data.roomId
  };

  if (params.text)
    base_json.markdown = params.text.replace(/<bold>/g, '**');
  if (params.imageUrl)
    base_json.files = [ params.imageUrl ];

  await spark.messages.create(base_json);

  var fake_json = { speech: "" };

  if (params.contextOut)
    fake_json.contextOut = params.contextOut;

  return params.res.status(200).json(fake_json);
}

async function handleBotResponse(params) {
  if (params.info.source === 'spark') {
    return await handleSparkResponse({
      text: params.text,
      imageUrl: params.imageUrl,
      contextOut: params.contextOut,
      info: params.info,
      res: params.res
    });
  } else {
    return handleNonSparkResponse({
      speech: params.speech,
      text: params.text,
      imageUrl: params.imageUrl,
      contextOut: params.contextOut,
      source: params.info.source,
      res: params.res
    });
  }
}

function getNetworksList() {
  var networksList = Object.values(networksArray);
  var finalList = [];
  for (var list of networksList)
    finalList.push(...list);
  return finalList;
}

async function listOrganizations(basicInfo, res) {
  var textMsg = "You are in the following <bold>organizations<bold>:\n";
  var voiceMsg = "You are in the following organizations: ";

  var orgNames = orgs.map(org => org.name);

  textMsg += orgNames.map((name, index) => `${index + 1}. ` + name).join('\n').trim();
  voiceMsg += orgNames.join(', ').trim();

  return await handleBotResponse({
    text: textMsg,
    speech: voiceMsg,
    info: basicInfo,
    res: res
  });
}

async function listNetworks(basicInfo, res) {
  var orgName = basicInfo.parameters.org || basicInfo.contexts.organization.org || undefined;

  if (orgName === undefined) {
    var msg = "The specified organization could not be found!";

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res
    });
  }

  orgName = orgName.trim();

  let org = fuseSearch(orgs, orgName, { keys: ['name'] });
  orgName = org.name.trim();
  let networks = networksArray[org.name.trim()];

  var textMsg = `Your organization, <bold>${orgName}<bold>, has the following networks:\n`;
  var voiceMsg = `Your organization, ${orgName}, has the following networks: `;

  var networkNames = networks.map(network => network.name);

  textMsg += networkNames.map((name, index) => `${index + 1}. ` + name).join('\n').trim();
  voiceMsg += networkNames.join(', ').trim();

  return await handleBotResponse({
    text: textMsg,
    speech: voiceMsg,
    contextOut: [
      {
        name: "organization",
        lifespan: 5,
        parameters: {
          "org": orgName
        }
      }
    ],
    info: basicInfo,
    res: res
  });
}

async function listDevices(basicInfo, res) {
  var netName = basicInfo.parameters.network || basicInfo.contexts.network.network || undefined;

  if (netName === undefined) {
    var msg = "The specified network could not be found!";

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res
    });
  }

  netName = netName.trim();

  let network = fuseSearch(getNetworksList(), netName, { keys: ['name'] });
  netName = network.name.trim();
  let devices = await dashboard.devices.list(network.id);

  var textMsg = `Your network, <bold>${netName}<bold>, has the following devices:\n`;
  var voiceMsg = `Your network, ${netName}, has the following devices: `;

  var deviceNames = devices.slice(0, 10).map(device => device.name || device.model);

  textMsg += deviceNames.map((name, index) => `${index + 1}. ` + name).join('\n').trim();
  voiceMsg += deviceNames.join(', ').trim();

  if (devices.length > 10) {
    textMsg += `\n+ ${devices.length - 10} other devices.`;
    voiceMsg += ` and ${devices.length - 10} other devices.`;
  }

  return await handleBotResponse({
    text: textMsg,
    speech: voiceMsg,
    contextOut: [
      {
        name: "network",
        lifespan: 5,
        parameters: {
          "network": netName
        }
      }
    ],
    info: basicInfo,
    res: res
  });
}

async function listAdmins(basicInfo, res) {
  var orgName = basicInfo.parameters.org || basicInfo.contexts.organization.org || undefined;

  if (orgName === undefined) {
    var msg = "The specified organization could not be found!"

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res
    });
  }

  orgName = orgName.trim();

  let org = fuseSearch(orgs, orgName, { keys: ['name'] });
  orgName = org.name.trim();
  let admins = await dashboard.admins.list(org.id);

  var textMsg = `Your organization, <bold>${orgName}<bold>, has the following administrators:\n`;
  var voiceMsg = `Your organization, ${orgName}, has the following administrators: `;

  var adminInfo = admins.slice(0, 10).map(admin => admin.name + " - " + admin.email);
  var adminNames = admins.slice(0, 10).map(admin => admin.name);

  textMsg += adminInfo.map((name, index) => `${index + 1}. ` + name).join('\n').trim();
  voiceMsg += adminNames.join(', ').trim();

  if (admins.length > 10) {
    textMsg += `\n+ ${admins.length - 10} other administrators.`;
    voiceMsg += ` and ${admins.length - 10} other administrators.`;
  }

  return await handleBotResponse({
    text: textMsg,
    speech: voiceMsg,
    contextOut: [
      {
        name: "organization",
        lifespan: 5,
        parameters: {
          "org": orgName
        }
      }
    ],
    info: basicInfo,
    res: res
  });
}

async function topTraffic(basicInfo, res) {
  var netName = basicInfo.parameters.network || basicInfo.contexts.network.network || undefined;
  var timeAmount = basicInfo.parameters['time-amount'] || basicInfo.contexts.network['time-amount'] || 1;
  var timeType = basicInfo.parameters['time-type'] || basicInfo.contexts.network['time-type'] || undefined;

  if (netName === undefined) {
    var msg = "The specified network could not be found!";

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res
    });
  }

  var totalSeconds = timeAmount * type2mult[timeType]
  if (totalSeconds < 2 * type2mult['hour'] || totalSeconds > type2mult['month']) {
    var msg = "Sorry, but you can only get traffic data from 2 hours to 1 month.";

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res
    });
  }

  netName = netName.trim();

  let network = fuseSearch(getNetworksList(), netName, { keys: ['name'] });
  netName = network.name.trim();

  console.log("got correct network")
  console.log(network);

  let trafficData = await dashboard.networks.getTrafficData(network.id, { 'timespan' : totalSeconds });

  console.log("got traffic data");
  if (trafficData.length === 0) {
    var msg = "No top traffic data has been found!"

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res
    });
  }

  var textMsg = `Your network, <bold>${netName}<bold>, has the following top 10 sites/apps for traffic:\n`;
  var voiceMsg = `Your network, ${netName}, has the following top 10 sites/apps for traffic: `;

  var top_traffic = trafficData.slice(0, 10).map(t_data => {
    return {
      app: t_data.application, source: t_data.destination, time: t_data.activeTime, numClients: t_data.numClients
    };
  }).sort((a, b) => b.time - a.time);

  textMsg += top_traffic.map((tt, index) => `${index + 1}. ${tt.app + (tt.source ? `@${tt.source}` : "")}: ${normalizeSeconds(tt.time)}`).join('\n');
  voiceMsg += top_traffic.map((tt, index) => `${tt.app + (tt.source ? ` from ${tt.source}` : "")} used for ${normalizeSeconds(tt.time)}`).join(', ');

  var pie = new quiche('pie');
  pie.setHostname('image-charts.com');
  pie.setWidth(700);
  pie.setHeight(700);
  for (var tt of top_traffic)
    pie.addData(tt.time, tt.app + (tt.source ? `@${tt.source}` : ""), randomColor().slice(1))
  var imageUrl = pie.getUrl(true).replace(/(chd=t%3A(\d+(\.\d+)?))&/g,'$1%2C0&'); // handling edge case where having only one data point breaks chart

  return await handleBotResponse({
    text: textMsg,
    speech: voiceMsg,
    imageUrl: imageUrl,
    contextOut: [
      {
        name: "network",
        lifespan: 5,
        parameters: {
          "network": netName
        }
      }
    ],
    info: basicInfo,
    res: res
  });
}

async function dataUsage(basicInfo, res) {
  var netName = basicInfo.parameters.network || basicInfo.contexts.network.network || undefined;
  var timeAmount = basicInfo.parameters['time-amount'] || basicInfo.contexts.network.network['time-amount'] || 1;
  var timeType = basicInfo.parameters['time-type'] || basicInfo.contexts.network.network['time-type'] || undefined;

  if (netName === undefined) {
    var msg = "The specified network could not be found!";

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res
    });
  }

  netName = netName.trim();
  let network = fuseSearch(getNetworksList(), netName, { keys: ['name'] });
  netName = network.name.trim();

  let devices = await dashboard.devices.list(network.id);

  devices = devices.slice(0, 5)

  var totalSent = 0, totalReceived = 0, total;
  var clientCount = 0;

  var pie = new quiche('pie');
  pie.setHostname('image-charts.com');
  pie.setWidth(700);
  pie.setHeight(700);

  //devices = devices.splice(1);

  for (var device of devices) {
    console.log(device)
    var clients = await dashboard.clients.list(device.serial, { 'timespan' : timeAmount * type2mult[timeType] });
    for (var client of clients) {
      pie.addData(client.usage.sent + client.usage.recv, client.description, randomColor().slice(1));
      clientCount += 1;
      totalSent += client.usage.sent;
      totalReceived += client.usage.recv;
    }
  }

  if (clientCount == 0) {
    var msg = `No data usage in the past ${timeAmount} ${timeType}s!`;

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res
    });
  }

  var imageUrl = pie.getUrl(true).replace(/(chd=t%3A(\d+(\.\d+)?))&/g,'$1%2C0&'); // handling edge case where having only one data point breaks chart
  total = totalSent + totalReceived;

  var bytesOpts = { unitSeparator: ' ' };
  var bytesTotal = bytes(total, bytesOpts);
  var avgByteTotalClient = bytes(total / clientCount, bytesOpts);
  var bytesSent = bytes(totalSent, bytesOpts);
  var bytesReceived = bytes(totalReceived, bytesOpts);

  var addLineSpark = basicInfo.source === 'spark' ? '\n' : '';
  var textMsg = `* Total data usage with ${clientCount} clients over ${timeAmount} ${timeType}s: ${bytesTotal}\n${addLineSpark}` +
                `* Average data usage over ${timeAmount} ${timeType}s: ${avgByteTotalClient} per client\n${addLineSpark}` +
                `* Total data sent over ${timeAmount} ${timeType}s: ${bytesSent}\n${addLineSpark}` +
                `* Total data received over ${timeAmount} ${timeType}s: ${bytesReceived}`;
  var voiceMsg = `The total data usage with ${clientCount} clients over ${timeAmount} ${timeType}s was ${bytesTotal}. On average, most clients used about ${avgByteTotalClient}. The total data sent over the same time period was ${bytesSent} and the total data received was ${bytesReceived}.`;

  return await handleBotResponse({
    text: textMsg,
    speech: voiceMsg,
    imageUrl: imageUrl,
    contextOut: [
      {
        name: "network",
        lifespan: 5,
        parameters: {
          "network": netName
        }
      }
    ],
    info: basicInfo,
    res: res
  });
}

async function blockSite(basicInfo, res) {
  var netName = basicInfo.parameters.network || basicInfo.contexts.network.network || undefined;
  var urls = basicInfo.parameters.urls ? basicInfo.parameters.urls : [];

  if (netName === undefined) {
    var msg = "The specified network could not be found!";

    return await handleBotResponse({
      text: msg,
      speech: msg,
      info: basicInfo,
      res: res,
    });
  }

  netName = netName.trim();

  let network = fuseSearch(getNetworksList(), netName, { keys: ['name'] });
  netName = network.name.trim();

  var goodUrls = [], badUrls = [], ipAddresses = [];

  for (var url of urls) {
    try {
      var address = await dns.lookup(url);
      goodUrls.push(url);
      ipAddresses.push(address);
    } catch (err) {
      badUrls.push(url);
    }
  }

  var rules = ipAddresses.map((ip, index) => {
    return {
      comment: 'Rule for blocking ' + urls[index],
      policy: 'deny',
      protocol: 'any',
      destPort: 'Any',
      destCidr: ip + '/32'
    }
  });

  var ssidsRaw = await dashboard.ssids.list(network.id);
  var ssids = ssidsRaw.filter(ssidRaw => ssidRaw.enabled).map(ssidRaw => ssidRaw.number);

  for (var ssid of ssids) {
    await dashboard.mr_l3_firewall.updateRules(network.id, ssid, { rules: rules });
  }

  var msg = '';
  if (goodUrls.length > 0) msg += `Successfully blocked ` + goodUrls.join(', ') + '. ';
  if (badUrls.length > 0) msg += `Failed to block ` + badUrls.join(', ') + '.';
  msg = msg.trim();

  return await handleBotResponse({
    text: msg,
    speech: msg,
    contextOut: [
      {
        name: "network",
        lifespan: 5,
        parameters: {
          "network": netName
        }
      }
    ],
    info: basicInfo,
    res: res
  });
}

async function helpMe(basicInfo, res) {
  var textMsg = `Here's a list of the possible commands:
  * list my organizations
  * list the networks in the Read Write Sandbox org
  * list the admins in my org
  * list the devices in the Sandbox 3 network
  * total data usage over the last 30 minutes (networks only)
  * top apps/sites used in the past 24 hours (networks only)
  * block facebook.com`;

  var voiceMsg = `Here's a list of the possible commands: list my organizations, list the networks in the Read Write Sandbox org, list the admins in my org, list the devices in the Sandbox 3 network, total data usage over the last 30 minutes, top apps or sites used in the past 24 hours, and block facebook.com. Now what would you like to do?`;

  return await handleBotResponse({
    text: textMsg,
    speech: voiceMsg,
    info: basicInfo,
    res: res
  });
}

var full_action_map = {
  list: {
    orgs: listOrganizations,
    networks: listNetworks,
    devices: listDevices,
    admins: listAdmins
    //clients: listClients
  },
  /*filter: {
    orgs: filterOrganizations,
    networks: filterNetworks,
    devices: filterDevices,
    admins: filterAdmins,
    clients: filterClients
  },
  search: {
    orgs: searchOrganizations,
    networks: searchNetworks,
    devices: searchDevices,
    admins: searchAdmins,
    clients: searchClients
  },*/
  statistics: {
    traffic: topTraffic,
    usage: dataUsage
  },
  actions: {
    block: blockSite
  },
  other: {
    help: helpMe
  }
};

// pre-warm lists before exporting
(async function () {
  if (!orgs || !orgs.length)
    orgs = await dashboard.organizations.list();
  for (var index in orgs) {
    if (orgs[index].name.trim() == "OctaBytes") {
      delete orgs[index];
    }
  }
  orgs = orgs.filter(org => !!org)
  if (!networksArray || !networksArray.length) {
    networksArray = {}
    for (var org of orgs) {
      networksArray[org.name.trim()] = await dashboard.networks.list(org.id);
    }
  }
})();

// build module.exports
for (var funcGroup of Object.values(full_action_map)) {
  for (var func of Object.values(funcGroup)) {
    // skip over non-function fields
    if (typeof func === "function")
      module.exports[func.name] = func;
  }
}