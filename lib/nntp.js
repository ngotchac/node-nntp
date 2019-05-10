'use strict';

var domain = require('domain'),
    xtend = require('xtend'),
    Response = require('./response'),
    ResponseStream = require('./streams/response'),
    MultilineStream = require('./streams/multiline'),
    CompressedStream = require('./streams/compressed');

var defaults = {
  host: 'localhost',
  port: 119,
  secure: false,
};

function NNTP (options) {
  this.options = xtend(defaults, options || {});

  var socket, self = this;

  this.connect = function (callback) {
    socket = require(self.options.secure ? 'tls' : 'net').connect(self.options.port, self.options.host);

    getResponse(false, false, function (error, response) {
      self.isConnected = true;
      callback(error, response);
    });
  };

  /**
   * Shorthand function for connect and authenticate in one call.
   */
  this.connectAndAuthenticate = function (callback) {
    this.connect(function (error, response) {
      if (error) {
        return callback(error);
      }

      if (undefined === self.options.username) {
        return callback(null, response);
      }

      self.authenticate(callback);
    });
  };

  this.disconnect = function (callback) {
    socket.once('end', function () {
      self.isConnected = false;
      callback();
    });

    socket.end();
  };

  this.authenticate = function (callback) {
    this.authInfo('USER', this.options.username, function (error, response) {
      if (error) {
        return callback(error);
      }

      if (response.status === 381) {
        if (undefined === self.options.password) {
          return callback(new Error('Password is required'));
        }

        return self.authInfo('PASS', self.options.password, callback);
      }

      callback(null, response);
    });
  };

  this.authInfo = function (type, value, callback) {
    getResponse(false, false, callback);
    socket.write('AUTHINFO ' + type + ' ' + value + '\r\n');
  };

  this.article = function (messageId, callback) {
    getResponse(true, false, function (error, response) {
      if (error) {
        return callback(error);
      }

      if (Response.NO_SUCH_ARTICLE === response.status) {
        return callback(new Error('No such article'));
      }

      if (Response.ARTICLE_RETRIEVED !== response.status) {
        return callback(new Error('Unexpected response received: ' + JSON.stringify(response)));
      }

      var inBody = false;
      var body = [];
      var headers = [];
      response.lines.forEach(function (line) {
        if (line.trim().length === 0 && inBody === false) {
          inBody = true;
        } else {
          if (inBody){
            body.push(line);
          } else {
            headers.push(line);
          }
        }
      });

      callback(null, { headers: headers, body: body });
    });

    socket.write('ARTICLE ' + messageId + '\r\n');
  };
    
  this.head = function (messageId, callback) {
    getResponse(false, false, function (error, response) {
      if (error) {
        return callback(error);
      }

      callback(null, response);
    });

    socket.write('HEAD ' + messageId + '\r\n');
  };
    
  this.stat = function (messageId, callback) {
    getResponse(false, false, function (error, response) {
      if (error) {
        return callback(error);
      }

      callback(null, response);
    });

    socket.write('STAT ' + messageId + '\r\n');
  };

  this.group = function (group, callback) {
    getResponse(false, false, function (error, response) {
      if (error) {
        return callback(error);
      }

      if (Response.NO_SUCH_GROUP === response.status) {
        return callback(new Error('No such group'));
      }

      if (Response.GROUP_SELECTED !== response.status) {
        return callback(new Error('Unexpected response received: ' + JSON.stringify(response)));
      }

      var messageParts = response.message.split(' ');

      callback(null, {
        name:  messageParts[3],
        count: parseInt(messageParts[0], 10),
        first: parseInt(messageParts[1], 10),
        last:  parseInt(messageParts[2], 10),
      });
    });

    socket.write('GROUP ' + group + '\r\n');
  };

  this.overviewFormat = function (callback) {
    getResponse(true, false, function (error, response) {
      if (error) {
        return callback(error);
      }

      var format = [];
      response.lines.forEach(function (line) {
        if (line.substr(-5, 5).toLowerCase() === ':full') {
          format[line.slice(0, -5).toLowerCase()] = true;
        }
        else {
          format[line.slice(0, -1).toLowerCase()] = false;
        }
      });

      callback(null, format);
    });

    socket.write('LIST OVERVIEW.FMT\r\n');
  };

  this.xover = function (range, format, callback) {
    format = xtend({number: false}, format);

    getResponse(true, false, function (error, response) {
      if (error) {
        return callback(error);
      }

      callback(null, parseOverview(response.lines, format));
    });

    socket.write('XOVER ' + range + '\r\n');
  };

  this.xzver = function (range, format, callback) {
    format = xtend({number: false}, format);

    getResponse(true, true, function (error, response) {
      if (error) {
        return callback(error);
      }

      callback(null, parseOverview(response.lines, format));
    });

    socket.write('XZVER ' + range + '\r\n');
  };

  function getResponse(multiline, compressed, callback) {
    var d = domain.create();

    function done(error, response) {
      socket.unpipe();

      socket.removeAllListeners('data');
      socket.removeAllListeners('error');

      d.exit();

      callback(error, response);
    }

    d.on('error', function (error) {
      done(error, null);
    });

    d.run(function () {
      socket.on('error', function (error) {
        done(error, null);
      });

      var pipeable = socket;

      if (compressed) {
        pipeable = pipeable.pipe(new CompressedStream());
      }

      if (multiline) {
        pipeable = pipeable.pipe(new MultilineStream());
      }

      pipeable = pipeable.pipe(new ResponseStream(multiline));

      var response;
      pipeable.on('data', function (data) {
        response = data;
      });

      pipeable.on('end', function () {
        done(null, response);
      });
    });
  }

  function parseOverview(overview, format) {
    var messages = [];

    overview.forEach(function (line) {
      var messageParts = line.toString().split('\t'),
          message = {},
          messagePart;

      for (var field in format) {
        if (format.hasOwnProperty(field)) {
          messagePart = messageParts.shift();
          message[field] = format[field] ? messagePart.substring(messagePart.indexOf(':') + 1).trim() : messagePart;
        }
      }

      messages.push(message);
    });

    return messages;
  }
}

module.exports = NNTP;
