/* Copyright (c) 2017, STMicroelectronics, Gordon Williams, Tobias Schwalm - See the file LICENSE for copying permission. */
/*
  Largely inspired from SIM900 modem library
  Library for interfacing to the UG96 modem (Quectel).
  Uses the 'NetworkJS' library to provide a JS endpoint for HTTP.
*/

/* supported features

 - debug messages, 4 views :
 no debug, view in the module, view on the AT channel, full debug

 - Flow control, as Espruino implementation :
 Espruino sets the CTS pin
 whenever it is ready to receive data or whenever it is too busy to receive

 - full modem initialization :
   AT synchronization,
   SIM card detection,
   signal measurement,
   automatic operator selection

 - TCP Client working in Direct Push mode, up to 12 sockets

 - GeoLocalisation by base station
*/


/* Not supported features
 - TCP Client working in Buffer Access Mode
 - TCP Server
 - UDP Service
 - multiple PDP contexts
*/

/*
Sample code :

function QuectelStart(debug_quectel, debug_at) {
  debug_quectel = debug_quectel || false;
  debug_at = debug_at || false;

  // RTS, CTS settings
  pinMode(D11, "input", true);
  pinMode(D12, "output", true);

  Serial3.setup(115200, { rx: D9, tx : D8, cts: D12 });

  resetOptions = {
   rst: "A8",
   pwrkey: "A6",
   rst_active_level: 1,
   pwrkey_active_level: 0,
  };
  gprs = require('UG96').connect(Serial3, resetOptions, function(err) {
    console.log("connectCB entered...");
    if (err) throw err;
    setTimeout(doConnect,30000);
  });

  gprs.debug(debug_quectel, debug_at);

  gprs.initflowctrl(true);
}

function doConnect() {
  gprs.connect(APN, USERNAME, PASSWORD, function(err) {
    console.log("gprs.connectCB entered...");
    if (err) throw err;
    gprs.getIP(print);

    ...

  });
}

*/

var at;
var busy = false;


/* socks may have the following states:
undefined       : unused
true            : connected and ready
Wait            : waiting for connection (client), or for data to be sent
tobeclosed      : closed (either locally request or remotly or both)
                  but not yet closed because of data still in the pipe.
*/
var socks = [];

/*
each socket has its string buffer
where remote data are written (receipt of data from the modem)
and from where the local upper layer take the data
*/
var sockData = ["","","","","","","","","","","",""];
var MAXSOCKETS = 12;

/* physical turn on & reset pins */
var rst;
var rst_active_level;
var pwrkey;
var pwrkey_active_level;
var flowcontrol = false;

/* Geolocalisation variables :  longitude,latitude */
var longlat = "";
/* Geolocaliation state (running or not) */
var geoPos = false;

// by default, without setting, debug in the module is disabled
var dbg = false;

var ccid;

/* modem may have the following initialization states */
var AtInitSequence = {
  AT_SYNCHRO: 0,
  AT_RSP_FORMAT: 1,
  AT_ECHO_OFF: 2,
  AT_CPIN: 3,
  AT_SHOW_SIM_ID: 4,
  AT_QUERY_SIGNAL_QUALITY: 5,
  AT_PS_ATTACHMENT: 6,
  AT_AUTOMATIC_OPERATOR_SELECTION: 7,
  AT_LIST_CURRENT_OPERATORS: 8,
  AT_CURRENT_OPERATOR: 9,
  AT_HW_FLOW_CONTROL: 10,
};
/*
openSocket is triggered at the socket creation, as earlier as possible.
Nevertheless, this function can be delayed to enter in secure mode (since using of encrypted keys can take time in mbed )
In case of failure with Error code "socket connect failed", try and repeat 5 times the openSocket
*/
function openSocket(sckt, host, port, counter) {

  if (dbg) console.log('AT+QIOPEN=1,'+sckt+',"TCP",'+JSON.stringify(host)+','+port+',0,1');

  at.cmd('AT+QIOPEN=1,'+sckt+',"TCP",'+JSON.stringify(host)+','+port+',0,1\r\n',150000, function cb(d) {
    if (d=="OK") {
      if (dbg) console.log("AT+QIOPEN OK");
      return cb;
    } else if (d=='+QIOPEN: '+sckt+",0") {
      if (dbg) console.log(d);
      if (dbg) console.log("AT+QIOPEN completed with socket: " + sckt);
      socks[sckt] = true;
      return "";
    } else if (d=='+QIOPEN: '+sckt+",565") {
      if (dbg) console.log("AT+QIOPEN failure DNS parse failed...");
      socks[sckt] = "tobeclosed";
      return "";
    } else if (d=='+QIOPEN: '+sckt+",566") {
      if (dbg) console.log("AT+QIOPEN failure could not connect socket ...");
	    if (counter < 5) {
	      setTimeout(function cb(){console.log("repeat opening the socket ..."); openSocket(sckt, host, port,(counter+1));}, 3000);
	    } else {
          socks[sckt] = "tobeclosed";
        }
      return "";
    } else if (d=='+QIOPEN: '+sckt+",563") {
      if (dbg) console.log("AT+QIOPEN socket identity has been used..., socket is:" + sckt);
      socks[sckt] = true;
      return "";
    } else {
      if (dbg) console.log("AT+QIOPEN failed on socket:" + sckt);
      if (dbg) {
        at.cmd("AT+QIGETERROR\r\n",1000, function cb(d) {
          if (dbg) console.log(d);
        });
      }
      socks[sckt] = "tobeclosed";
      return "";
    }
  });
}

/*
Closesocket is run because of 2 triggers :
- either from a local trigger (http layer on the target)
- or from a remote trigger (host on network)

Closing is done for active socket which are not sending
-	check socket exists, verify the socket state is not "undefined"
- closing cannot bypass sending

Closing is possible if the AT media is free
- check if a AT communication is on-going

At the end, socket is either closed (successful) or waiting to be closed.
In this last case, either a new closing is initiated (remote if first attemps was local, local if first attemps was remote)
or triggered from this module when data buffer is emptied
- Mark this socket as tobeclosed, will be closed when data buffer emptied
*/
function closeSocket(socket) {
  if(socks[socket]) {
    if (busy) {
      if (dbg) console.log("at register currenly programmed");
      setTimeout(function cb(){console.log("closing later..."); closeSocket(socket);}, 1500);
    } else if (at.isBusy()){
      if (dbg) console.log("AT busy");
      setTimeout(function cb(){console.log("closing again..."); closeSocket(socket);}, 1500);
    } else {
      if (dbg) console.log("sending AT+QICLOSE for socket " + socket);
      at.cmd('AT+QICLOSE='+socket+"\r\n",1000, function(d) {
        if (dbg) console.log(d);
        if (d=="OK") {
          if (dbg) console.log("socket " + socket + " is closed");
          socks[socket] = undefined;
        } else {
          if (dbg) console.log("cannot close socket now" + socket +",error=" + d);
          socks[socket] = "tobeclosed";
        }
      });
    }
  } else {
    if (dbg) console.log("socket already closed");
  }
}

/*
abortWaiting frees the registering (preventive)
*/
function abortWaitingPrompt() {
  console.log("Abort waiting prompt (for sending data)");
  busy = false;
  at.unregister('>');
}

function abortWaitingModemRsp() {
  console.log("Abort waiting modem response (sending data)");
  busy = false;
  at.unregisterLine('SEND OK');
  at.unregisterLine('SEND FAIL');
  at.unregisterLine('ERROR');
}

var netCallbacks = {
  create: function(host, port) {
    var sckt = 0;
    /* Create a socket and return its index, host is a string, port is an integer.
    If host isn't defined, create a server socket */
    if (host===undefined) {
      if (dbg) console.log("WARNING: this has not been fully ported for UGxx");
      sckt = MAXSOCKETS;
      socks[sckt] = "Wait";
      sockData[sckt] = "";
      at.cmd("AT+CIPSERVER=1,"+port+"\r\n", 10000, function(d) {
        if (d=="OK") {
          socks[sckt] = true;
        } else {
          socks[sckt] = undefined;
          throw new Error("CIPSERVER failed");
        }
      });
      return MAXSOCKETS;
    } else {
      while (socks[sckt]!==undefined) sckt++; // find free socket
      if (sckt>=MAXSOCKETS) //throw new Error('No free sockets.')
	  {
        if (dbg) console.log("WORKAROUND closing the socket: " + sckt);
		sckt--;
		at.cmd('AT+QICLOSE='+sckt+"\r\n",1000, function(d) {
		if (dbg) console.log(d);
        socks[sckt] = undefined;
		});
	  }

      socks[sckt] = "Wait";
      sockData[sckt] = "";

      if (port == 443) {
        if (dbg) console.log("delaying the TLS socket opening");
        setTimeout(function cb(){openSocket(sckt, host, port,0);}, 3000);
      } else {
        openSocket(sckt, host, port,0);
      }
    }
    return sckt; // jshint ignore:line
  },
  /* Close the socket. returns nothing */
  close: function(sckt) {
    if (dbg) console.log("(local) Closing of the socket: " + sckt);
    closeSocket(sckt);
  },
  /* Accept the connection on the server socket. Returns socket number or -1 if no connection */
  accept: function(sckt) {
    if (dbg) console.log("Accept Socket",sckt);
    for (var i=0;i<MAXSOCKETS;i++) {
      if (sockData[i] && socks[i]===undefined) {
        //if (dbg) console.log("Socket accept "+i,JSON.stringify(sockData[i]),socks[i]);
        socks[i] = true;
        return i;
      }
    }
    return -1;
  },
  /* Receive data. Returns a string (even if empty).
  If non-string returned, socket is then closed */
  recv: function(sckt, maxLen) {
    if (at.isBusy() || socks[sckt]=="Wait") return "";
    if (sockData[sckt]) {
      var r;

      if (sockData[sckt].length > maxLen) {
        r = sockData[sckt].substr(0,maxLen);
        sockData[sckt] = sockData[sckt].substr(maxLen);
      } else {
        r = sockData[sckt];
        sockData[sckt] = "";
      }
      return r;
    }
    if (!socks[sckt]) return -1; // close it
    // No more data in pipe and status closing, so request close
    if (socks[sckt]=="tobeclosed") return -1; // request closing
    return "";
  },
  /* Send data. Returns the number of bytes sent - 0 is ok.
  Less than 0 as a request to close the socket */
  send: function(sckt, data) {
    if (busy || at.isBusy() || socks[sckt]=="Wait") return 0;
    if (socks[sckt]=="tobeclosed") return -1; // request closing
    if (!socks[sckt]) return -1; // error - close it
    if (data.length > 1460) { if (dbg) console.log("data too big"); return -1; } // error - close it

    busy = true;

    var idWaitingPrompt = setTimeout(function(){abortWaitingPrompt()},1000);

    at.register('>', function() {
      if (dbg) console.log("Prompt coming, sending data ...");
      at.unregister('>');
      clearTimeout(idWaitingPrompt);
      at.write(data);
      return "";
    });

    var idWaitingModemRsp = setTimeout(function(){abortWaitingModemRsp()},1000);

	/* wait for the modem response */
    at.registerLine('SEND OK', function() {
      if (dbg) console.log("UGxx - SEND OK");
      at.unregisterLine('SEND OK');
      at.unregisterLine('SEND FAIL');
      at.unregisterLine('ERROR');
      clearTimeout(idWaitingModemRsp);
      busy = false;
      return "";
    });

	/* connection has been established but sending buffer is full */
	/* wait for the modem response */
     at.registerLine('SEND FAIL', function() {
      if (dbg) console.log("UGxx - SEND FAIL");
      at.unregisterLine('SEND OK');
      at.unregisterLine('SEND FAIL');
      at.unregisterLine('ERROR');
      clearTimeout(idWaitingModemRsp);
      busy = false;
      socks[sckt]=="tobeclosed"
      return "";
    });

	/* connection has not been established, abnormally closed, or parameter is incorrect */
     at.registerLine('ERROR', function() {
      if (dbg) console.log("UGxx - ERROR communication");
      at.unregisterLine('SEND OK');
      at.unregisterLine('SEND FAIL');
      at.unregisterLine('ERROR');
      clearTimeout(idWaitingModemRsp);
      busy = false;
      socks[sckt]=="tobeclosed"
      return "";
    });

    at.write('AT+QISEND='+sckt+','+data.length+'\r\n');
    return data.length;
  }
};

/*
Handle +QUIRC incoming data from modem previously configured in direct push mode

Typical expected format : +QIURC:"recv",<connectID>,<currentrecvlength><CR><LF><data>

 Several cases :
 - case 1 : receipt of something where end of line is missing
+QIURC: "recv"

- case 2 : receipt of something where line is smaller than expected
+QIURC: "recv",0,259\r\nHTTP/1.1 "

- case 3 : receipt of something where line is greater than expected
+QIURC: "recv",0,263\r\ndata\r\n+QIURC: "closed",0\r\n

*/
function receiveHandler(line) {
  // colon equal -1 when end of line is missing (case 1)
  var colon = line.indexOf("\r\n");

  // no <CR><LF> or line too short
  if (colon<0) {
	  return line; // not enough data here at the moment
  }

  var parms = line.substring(15,colon).split(",");

  // trick here is to converted string into integer
  parms[1] = 0|parms[1];

  // len :  length of the remaining characters beyond the first line
  var len = line.length-(colon+2);

  if (len>=parms[1]) {
   // we have everything
	sockData[parms[0]] += line.substr(colon+2,parms[1]);

	return line.substr(colon+parms[1]+3); // return anything else
  } else {
	// still some to get
	sockData[parms[0]] += line.substr(colon+2,len);

   return "+D,"+parms[0]+","+(parms[1]-len)+":"; // return +D so receiveHandler2 gets called next time
  }
}
function receiveHandler2(line) {

  var colon = line.indexOf(":");
  if (colon<0) {
	return line; // not enough data here at the moment
  }
  var parms = line.substring(3,colon).split(",");
  parms[1] = 0|parms[1];
  var len = line.length-(colon+1);
  if (len>=parms[1]) {
   // we have everything
   sockData[parms[0]] += line.substr(colon+1,parms[1]);

   return line.substr(colon+parms[1]+1); // return anything else
  } else {
   // still some to get
   sockData[parms[0]] += line.substr(colon+1,len);

   return "+D,"+parms[0]+","+(parms[1]-len)+":"; // return +D so receiveHandler2 gets called next time
  }
}

/*
When TCP socket service is closed by remote peer or network error, this function is entered

Typical expected format : +QIURC: "recv",<connectID><CR><LF>

First search for <CR><LF> index in the line to locate the end
Note <CR> is enough (no need to wait for <LF>) : this will immediatly closes the socket

2 options
- Not enough data may not have been received at this moment so that line is simply returned.
- Enough data may finally be received then search for the <connectID>
<connectID> is the socket index to close.

Note the trick to convert string into integer with this instruction :
parms[1] = 0|parms[1];
*/
function closehandler(line) {
  if (dbg) console.log("closehandler:" + line);

  var colon = line.indexOf("\r\n");

  if (colon<0) {
    if (dbg) console.log("not enough data " + line);

    var colon = line.indexOf("\r");
    if (colon<0) {
      if (dbg) console.log("definitively not enough data " + line);
      return line;
    }
  }
  var parms = line.substring(0,colon).split(",");

  parms[1] = 0|parms[1];

  closeSocket(parms[1]);
  return ""
}

function pdpdeacthandler(line) {
  if (dbg) console.log("pdpdeacthandler:" + line);
  at.cmd("AT+QIDEACT=1\r\n",1000, function(d) {
    if (dbg) console.log(d);
    // reset internal state
    for (var i=0;i<MAXSOCKETS;i++) {
        socks[i] = undefined;
        sockData[i] = "";
    }
  });

  return ""
}

// Dust QIND URC (not currently managed in this version)
// it conveyed
//	+QIND: SMS DONE SMS initialization finished
//  +QIND: PB DONE Phonebook initialization finished
// 1st option : dust the line (selected in the code)
//
// 2nd option : dust only this message (to have in mind)
//var colon = line.indexOf("\r\n");
//var endstr = line.substr(colon,line.length);
//console.log(line.substr(colon,line.length));
// re_inject other commands
//return endstr;
function QindHandler(line) {
  if (dbg) console.log('QindHandler in: ' + line);

  return "";
}

// Dust QSIM URC (not currently managed in this version)
// it gives SIM technology
//	+QUSIM: 0 Use SIM card
//  +QUSIM: 1 Use USIM card
// 1st option : dust the line (selected in the code)
//
// 2nd option : dust only this message (to have in mind)
//var colon = line.indexOf("\r\n");
//var endstr = line.substr(colon,line.length);
//console.log(line.substr(colon,line.length));
// re_inject other commands
//return endstr;
function QusimHandler(line) {
  if (dbg) console.log('QusimHandler in: ' + line);

  return "";
}

// Dust CFUN URC (not currently managed in this version)
// 1st option : dust the line (selected in the code)
//
// 2nd option : dust only this message (to have in mind)
//var colon = line.indexOf("\r\n");
//var endstr = line.substr(colon,line.length);
//console.log(line.substr(colon,line.length));
// re_inject other commands
//return endstr;
function CfunHandler(line) {
  if (dbg) console.log('CfunHandler in: ' + line);

  return "";
}

// Dust CFUN URC (not currently managed in this version)
// It means : "ME initialization is successful"
// 1st option : dust the line (selected in the code)
//
// 2nd option : dust only this message (to have in mind)
//var colon = line.indexOf("\r\n");
//var endstr = line.substr(colon,line.length);
//console.log(line.substr(colon,line.length));
// re_inject other commands
function RdyHandler(line) {
  if (dbg) console.log('RdyHandler in: ' + line);

  return "";
}

// Manage POWERED DOWN URC
// This is received when the modem has stored its data
// and deregistered(for instance saving of registered PLMN)
// Manage the pins so that modem is physically off
function PoweredDownHandler(line) {
  if (dbg) console.log('PowerDownHandler in: ' + line);

  console.log("Modem is entering in power down");
  digitalWrite(pwrkey, pwrkey_active_level);

  return "";
}

var gprsFuncs = {
  receiveHandler: receiveHandler,
  "debug" : function(dbg_gprs = false, dbg_at = false) {
  dbg = dbg_gprs;
  // Return some debug data, but also enable debug mode.
  // Debug mode prints out what is sent and received
  if (dbg_at)  at.debug();
   return {
      socks:socks,
      sockData:sockData
    };
  },
  // initialise the modem
  // - Send AT command several times to synchronise with modem (autobaud feature)
  // - Set echo mode to OFF
  // - Check SIM card is accessible and ready (not pin protected of blocked)
  // - Show SIM ID (ICCID) for debug purposes
  // - query signal quality for information on the radio conditions
  // - Attemp a PS attachment or enter in an automatic mode searching for PLMNs
  "init": function(callback) {
	var atSync = 0;
    var attRetry = 0;
    var s = AtInitSequence.AT_SYNCHRO;
    var signal_quality_report = false;

    var cb = function(r) {
      switch(s) {
        case AtInitSequence.AT_SYNCHRO:

          if (dbg) console.log("debug AT_SYNCHRO :" +r);

          if(r === 'AT') {
            // wait for OK
            return cb;
          }
          else
          {
            if(r === 'OK') {
              console.log("AT passed");

              s = AtInitSequence.AT_RSP_FORMAT;
              at.cmd("ATV1\r\n",1000,cb);
            }   else {
              s = AtInitSequence.AT_SYNCHRO;
              atSync++;
              if (dbg) console.log("AT sync failed: " +r);

              if (atSync <= 10) {
                setTimeout(function(){at.cmd('AT\r\n', 1000, cb);},500);
              }
                else {
                  if (dbg) console.log("No OK return after 10 times");
                  if (dbg) console.log("Check the module is power on");
                  callback('Error in AT sync: ' + r);
              }
            }
          }
          break;
        case AtInitSequence.AT_RSP_FORMAT:

          if (dbg) console.log("debug AT_RSP_FORMAT :" +r);

          /* Case processing with a response */
          if(r === 'OK') {
            // remove the echo
            s = AtInitSequence.AT_ECHO_OFF;
            at.cmd("ATE0\r\n",1000,cb);
          } else if(r === 'ATV1') {
            // wait for OK
            return cb;
          } else if(r) {
            callback('Error in ATV1: ' + r);
          }

          /* case processing with no response */
          if (r===undefined) {
           if (dbg) console.log("Cannot set TA response format");
           callback('ATV1 time-out !!!');
          }
          break;

        case AtInitSequence.AT_ECHO_OFF:

          if (dbg) console.log("debug AT_ECHO_OFF :" +r);

          /* Case processing with a response */
          if(r === 'IIIIATE0' ||
           r === 'IIII' + String.fromCharCode(255) + 'ATE0' ||
           r === 'ATE0') {

            // wait for OK
            return cb;
          } else if(r === 'OK') {
            if (dbg) console.log("ATE0 passed: " +r);
            if (flowcontrol) {
              s = AtInitSequence.AT_HW_FLOW_CONTROL;
              at.cmd('AT+IFC=2,2\r\n', 2000, cb);
            } else {
              s = AtInitSequence.AT_CPIN;
              at.cmd('AT+CPIN?\r\n', 5000, cb);
            }
          } else if (r === 'atE0') {
            if (dbg) console.log("UGxx returns " + r);
            s = AtInitSequence.AT_CPIN;
            at.cmd('AT+CPIN?\r\n', 5000, cb);
          } else if(r) {
            callback('Error in ATE0: ' + r);
          }

          /* case processing with no response */
          if (r===undefined) {
            if (dbg) console.log('ATE0 time-out !!!');
            s = AtInitSequence.AT_CPIN;
            at.cmd('AT+CPIN?\r\n', 5000, cb);
          }
          break;

        case AtInitSequence.AT_HW_FLOW_CONTROL:

          if (dbg) console.log("debug AT_HW_FLOW_CONTROL :" +r);

          /* Case processing with a response */
          if(r === 'OK') {
            if (dbg) console.log("HW flow control establismnent succeeded");

            s = AtInitSequence.AT_CPIN;
            at.cmd('AT+CPIN?\r\n', 5000, cb);

          } else {
            callback('HW flow control establismnent failed');
            s = AtInitSequence.AT_CPIN;
            at.cmd('AT+CPIN?\r\n', 5000, cb);
          }
          break;

        case AtInitSequence.AT_CPIN:

          if (dbg) console.log("debug AT_CPIN :" +r);

          /* Case processing with a response */
          if(r === '+CPIN: READY') {
            // wait for OK
            return cb;
          } else if (r === 'OK') {
            s = AtInitSequence.AT_SHOW_SIM_ID;
            at.cmd('AT+QCCID\r\n', 2000, cb);
          } else if(r) {
            callback('Error in CPIN: ' + r);
          }

          /* case processing with no response */
          if (r===undefined) {
           if (dbg) console.log("SIM cannot be read, SIM is either protected, blocked or not accessible");
           callback('AT+CPIN time-out !!!');
          }
          break;

        case AtInitSequence.AT_SHOW_SIM_ID:

          if (dbg) console.log("debug AT_SHOW_SIM_ID :" +r);

          /* Case processing with a response */
          if (r&&r.substr(0,7)=="+QCCID:") {
            if (dbg) console.log("SIM ID :" +r);

            ccid = r.substring(8,r.length-1);

            // wait for OK
            return cb;
          } else if (r === 'OK') {
            s = AtInitSequence.AT_QUERY_SIGNAL_QUALITY;
            // check the signal quality in the field
            at.cmd('AT+CSQ\r\n', 2000, cb);
          } else if(r) {
            callback('Error in QCCID: ' + r);
          }

          /* case processing with no response */
          if (r===undefined) {
            callback('AT+QCCID time-out !!!');
          }
          break;

        case AtInitSequence.AT_QUERY_SIGNAL_QUALITY:

          if (dbg) console.log("debug AT_QUERY_SIGNAL_QUALITY :" +r);

          /* Case processing with a response */
          if (r&&r.substr(0,5)=="+CSQ:") {
            // check signal is detectable before attempting attachment
            if (r&&r.substr(0,11)=="+CSQ: 99,99") {
              if (dbg) console.log("Signal not known or not detectable yet");
              signal_quality_report = false;
            } else {
              signal_quality_report = true;
              if (dbg) console.log("Info signal :" +r);

              // comment on quality signal for user to be done here
            }

            // wait for OK
            return cb;
          } else if (r === 'OK') {
            if (signal_quality_report) {
              s = AtInitSequence.AT_PS_ATTACHMENT;
              // check if we're on network
              if (dbg) console.log('PS attachment is starting. It may take until a minute, please wait ... ');
              setTimeout(function(){at.cmd('AT+CGATT=1\r\n', 75000, cb);},5000);
            } else {
              // start and wait for the next quality signal report sequence
             setTimeout(function(){at.cmd('AT+CSQ\r\n', 2000, cb);},500);
            }
          } else if(r) {
				callback('Error in QCCID: ' + r);
          }

          /* case processing with no response */
          if (r===undefined) {
            callback('AT+CSQ time-out !!!');
          }

		  break;

        case AtInitSequence.AT_PS_ATTACHMENT:

          if (dbg) console.log("debug AT_PS_ATTACMENT :" +r);

          if(r === 'OK') {
            console.log("PS attachment succeeded");
            s = AtInitSequence.AT_CURRENT_OPERATOR;
            at.cmd('AT+COPS?\r\n', 20000, cb);
          } else if(r) {
            attRetry = attRetry +1;
            if (dbg) console.log('Error in CGATT: ' + r + " - retry: " + attRetry);
            // CGATT has probably been called too early: let's give 3 (re)tries before concluding we do have an unrecoverable PS registration failure
            // First we will force the modem to search a network and register (regardless of PS service)
            if(1==attRetry) {
              if (dbg) console.log("Trying an automatic registration first. It may take until 3 minutes, please wait ...");
              s = AtInitSequence.AT_AUTOMATIC_OPERATOR_SELECTION;
              setTimeout(function(){at.cmd('AT+COPS=0\r\n', 180000, cb);},2000);
            } else if(attRetry<4) {
              if (dbg) console.log("Retrying CGATT");
              s = AtInitSequence.AT_PS_ATTACHMENT;
              if (dbg) console.log('PS attacment is attempting again. It may take until a minute, please wait ... ');
              setTimeout(function(){at.cmd('AT+CGATT=1\r\n', 75000, cb);},2000*attRetry);
            } else {callback('Unrecoverable Error, PS attachment failed: ' + r);}
          }
          break;

        case AtInitSequence.AT_AUTOMATIC_OPERATOR_SELECTION:
          // We do not check the return code, instead we ask for the COPS status
          if (dbg) console.log("COPS returns: " + r);
          s = AtInitSequence.AT_LIST_CURRENT_OPERATORS;
          setTimeout(function(){at.cmd('AT+COPS?\r\n', 10000, cb);},5000);
          break;

        case AtInitSequence.AT_LIST_CURRENT_OPERATORS:
          // Let's do a blind retry of CGATT in 30sec from now (let's give time to the modem to handle the 3GPP re-attempts)
          if (dbg) console.log(r + " - Now retrying PS attachment");
          s = AtInitSequence.AT_PS_ATTACHMENT;
          setTimeout(function(){at.cmd('AT+CGATT=1\r\n', 30000, cb);},30000);
          break;

        case AtInitSequence.AT_CURRENT_OPERATOR:

          if (dbg) console.log("debug AT_CURRENT_OPERATOR :" +r);

          /* Case processing with a response */
          if(r === 'OK') {
            callback(null);
          }
          else if (r&&r.substr(0,6)=="+COPS:") {
            console.log("currently selected operator :" +r);
            // wait for OK
            return cb;
          } else if(r) {
            callback('Error in COPS? ' + r);
          }

          /* case processing with no response */
          if (r===undefined) {
            callback('AT+COPS? time-out !!!');
          }
          break;

      }
    };
    /* repeat AT SYNC: Send AT every 500ms, if receive OK, SYNC success, if no OK return after sending AT 10 times, SYNC fail */
    setTimeout(function(){at.cmd('AT\r\n', 1000, cb);},500);
  },
  "reset": function(callback) {
    function reset_pulse(callback) {
      digitalWrite(rst, rst_active_level);
      setTimeout(function() {
        digitalWrite(rst, !rst_active_level);
        setTimeout(function() {
          gprsFuncs.init(callback);
        }, 6000);
      }, 200);
    };

    function pwrkey_pulse(callback) {
      digitalWrite(pwrkey, pwrkey_active_level);
      setTimeout(function() {
        digitalWrite(pwrkey, !pwrkey_active_level);
        setTimeout(function() {
            if(rst) {
              reset_pulse(callback);
            } else {
              gprsFuncs.init(callback);
            }
        }, 5000);
      }, 200);
    };

    // reset state
    for (var i=0;i<MAXSOCKETS;i++) {
        socks[i] = undefined;
        sockData[i] = "";
    }
    if (rst === undefined && pwrkey===undefined) return gprsFuncs.init(callback);
    if (dbg) console.log("Here we go trhough reset sequence");
    // ensure reset is not active
    if (rst) digitalWrite(rst, !rst_active_level);
    // there is either pwr_key or reset, if pwrkey start with it,
    // then use reset if present
    if (pwrkey) {
        pwrkey_pulse(callback);
    } else {
        reset_pulse(callback);
    }
  },
  "getVersion": function(callback) {
    at.cmd("AT+GMR\r\n", 1000, function(d) {
      callback(null,d);
    });
  },
  "connect": function(apn, username, password, callback) {
    var s = 0;
    var cb = function(r) {
      switch(s) {
        case 0:
          if (dbg) console.log("connect callback after PDP context configuration");
          if(r === 'OK') {
            s = 1;

            if (dbg) console.log("PDP context successfully configured");
            at.cmd('AT+QIACT=1\r\n', 30000, cb);
          } else if(r) {
            callback('Error in ' + s + ': ' + r);
          }
          if (r===undefined) {
            if (dbg) console.log("PDP context activation failed, timeout...");
          }
          break;

        case 1:
          if (dbg) console.log("connect callback after PDP context activation");
          if(r === 'OK') {
            console.log("PDP context successfully activated");
            callback(null);
          }
          else if(r) {
            callback('Error in ' + s + ': ' + r);
          } else {
            callback(null);
          }
          break;
      }
    };
    if (dbg) console.log("in the connect function: AT+QICSGP stage");
    at.cmd('AT+QICSGP=1,1,"'+apn + '", "' + username + '", "' + password + '"\r\n', 30000, cb);
  },
  "initflowctrl" : function(flowcontrol_modem = false) {
    flowcontrol = flowcontrol_modem;
  },
  "getIP": function(callback) {
    var ip = "";
    var cb = function(r) {
      if (dbg) console.log("AT+CGPADDR callback: " + r);
      if (r===undefined) {
        if (dbg) console.log("timeout : any IP address allocated ...");
          callback(null,ip);
      } else if (r==='OK') {
        callback(null,ip);
        console.log("IP address allocated, modem is ready to use");
      }
      else {
        ip = ip +r;
        if (dbg) console.log(r);
        return cb;
      }
    };

    if (dbg) console.log("getIP is AT+CGPADDR");
    at.cmd('AT+CGPADDR=1\r\n', 30000, cb);
  },
  "geoLocGet": function(callback) {
    console.log("Getting geolocalization data");
    callback(longlat);
  },
  "geoLocStart": function(period) {
    console.log("Starting GeoLocalization");
    if (period < 10000) console.log("unpredictive behaviour with period not greater than 10 s !");
    geoPos = true;

    var cb = function(r) {
        if (r===undefined) {
          if (dbg) console.log("GeoLocalization timeout");
          longlat = "";
        } else if (r==='OK') {
          console.log("GeoLocalization acquisition done : " + longlat);
        } else if (r&&r.substr(0,10)=="+QCELLLOC:") {
          var pos_last = r.length;
          var pos_space = r.indexOf(" ");
          longlat = r.substring(1+pos_space,pos_last);

          if (dbg) console.log(longlat);

          /* wait for OK */
          return cb;
        } else {
          longlat = "";
          console.log("Geolocalization error : " + r);
        }
      if (geoPos) {
        /* new trigger */
        setTimeout(function(){at.cmd('AT+QCELLLOC=1\r\n', 2000, cb);},period);
      }
    };

    at.cmd('AT+QCELLLOC=1\r\n', 2000, cb);
  },
  "geoLocStop": function() {
    console.log("Stopping GeoLocalization");

    geoPos = false;

    longlat = "";
  },
  "turnOff": function() {

    console.log("Turning Off the modem");

    var cb = function(r) {
      if (r==='OK') {
          console.log("Please wait, disconnecting and saving data. It may last until 60 s");

          /* wait for POWERED DOWN and manage it in the URCs table */
		  /* other URCs can be received before the modem has terminated its shut down */
      } else {
        console.log("Turn off error : " + r);
      }
    };
    // Normal power down
    at.cmd('AT+QPOWD=1\r\n', 2000, cb);
  },
  "getCCID": function() {
    return ccid;
  },
};

resetOptions = {
 rst: undefined,
 pwrkey: undefined,
 rst_active_level: 1,
 pwrkey_active_level: 1,
};

/*
This is the 'exported' (named function)
it can be used with :
require('UG96.js').connect(Serial, resetOptions, function(err) { console.log("connecting..."); });

This sets the pins to turn on, reset the module.
This loads the submodules required to work with.

This manages QIURC (Quectel Incoming Unsolicited Result Code)
- URC of Incoming Data
- URC of Connection Closed
- URC of PDP Deactivation

This Manage URC (Unsolicited Result Code) with no conditional triggers
(UGxx AT Commands Manual, Table 12: Summary of URC )

this reset the modem
*/
exports.connect = function(usart, resetOptions, connectedCallback) {
  resetOptions = resetOptions || {};
  rst = resetOptions.rst || undefined;
  pwrkey = resetOptions.pwrkey || undefined;
  rst_active_level = resetOptions.rst_active_level || 0;
  pwrkey_active_level = resetOptions.pwrkey_active_level || 0;

  gprsFuncs.at = at = require('AT').connect(usart);
  require("NetworkJS").create(netCallbacks);

  at.register("+QIURC: \"recv\"", receiveHandler);
  at.register("+D", receiveHandler2);
  at.register("+QIURC: \"closed\"", closehandler);
  at.register("+QIURC: \"pdpdeact\"", pdpdeacthandler);

  at.register("+QIND:", QindHandler);
  at.register("+QUSIM:", QusimHandler);
  at.register("+CFUN:", CfunHandler);
  at.register("RDY", RdyHandler);
  at.register("POWERED DOWN", PoweredDownHandler);

  gprsFuncs.reset(connectedCallback);
  return gprsFuncs;
};
