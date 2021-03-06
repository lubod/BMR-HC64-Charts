
import express from 'express';
import redis from 'redis';
import { AddressInfo } from 'net';
import { DomTrendData, StationData, StationDataRaw, StationTrendData } from '../client/models/model';

let proxy = require('express-http-proxy');

const jwt = require('jsonwebtoken');
const jwkToPem = require('jwk-to-pem');
const jwk = JSON.parse(process.env.JWK) || {};
const pem = jwkToPem(jwk.keys[1]);

const app = express();
const redisClient = redis.createClient();

const CLIENT_ID = process.env.CLIENT_ID || '';
const USERNAME = process.env.USERNAME || '';
const STATION_PASSKEY = process.env.STATION_PASSKEY || '';
const DOM_PASSKEY = process.env.DOM_PASSKEY || '';

let http = require("http").Server(app);
// set up socket.io and bind it to our
// http server.
let io = require("socket.io")(http);

let sockets: any[] = [];

function socketEmitData(channel: string, data: any) {
    sockets.forEach(socket => {
        socket.emit(channel, data);
    });
}

app.use(express.static(__dirname));
app.use(
    express.urlencoded({
        extended: true
    })
);

app.use(express.json());
app.use('/charts', proxy('localhost:3000/charts', {
    filter: function (req: any, res: any) {
        if (req.query.token) {
            return verifyToken(req.query.token) !== null;
        }

        const urlParams = new URLSearchParams(req.headers.referer);
        const token = urlParams.get('token')
        return verifyToken(token) !== null;
    }
}));

function verifyToken(token: any) {
    if (token) {
        try {
            const decodedToken = jwt.verify(token, pem, { algorithms: ['RS256'] });
            if (decodedToken.client_id !== CLIENT_ID) {
                console.error('client_id');
                return null;
            }
            if (decodedToken.username !== USERNAME) {
                console.error('username');
                //                return false;
            }
            console.info(decodedToken);
            return decodedToken.username;
        } catch (err) {
            console.error(err);
            return null;
        }
    }
    return null;
}

function decodeStationData(data: StationDataRaw) {
    const TO_MM = 25.4;
    const TO_KM = 1.6;
    const TO_HPA = 33.8639;

    function round(value: number, precision: number) {
        var multiplier = Math.pow(10, precision || 0);
        return Math.round(value * multiplier) / multiplier;
    }

    //    console.log(data);
    let decoded = new StationData();
    decoded.timestamp = new Date(data.dateutc + ' UTC').toISOString();
    decoded.tempin = round((5 / 9) * (data.tempinf - 32), 1);
    decoded.pressurerel = round(data.baromrelin * TO_HPA, 1);
    decoded.pressureabs = round(data.baromabsin * TO_HPA, 1);
    decoded.temp = round((5 / 9) * (data.tempf - 32), 1);
    decoded.windspeed = round(data.windspeedmph * TO_KM, 1);
    decoded.windgust = round(data.windgustmph * TO_KM, 1);
    decoded.maxdailygust = round(data.maxdailygust * TO_KM, 1);
    decoded.rainrate = round(data.rainratein * TO_MM, 1);
    decoded.eventrain = round(data.eventrainin * TO_MM, 1);
    decoded.hourlyrain = round(data.hourlyrainin * TO_MM, 1);
    decoded.dailyrain = round(data.dailyrainin * TO_MM, 1);
    decoded.weeklyrain = round(data.weeklyrainin * TO_MM, 1);
    decoded.monthlyrain = round(data.monthlyrainin * TO_MM, 1);
    decoded.totalrain = round(data.totalrainin * TO_MM, 1);
    decoded.solarradiation = round(data.solarradiation * 1.0, 0);
    decoded.uv = round(data.uv * 1.0, 0);
    decoded.humidity = round(data.humidity * 1.0, 0);
    decoded.humidityin = round(data.humidityin * 1.0, 0);
    decoded.winddir = round(data.winddir * 1.0, 0);
    return decoded;
}

app.post('/setData', function (req: any, res: any) {
    console.info('/setData');
    if (req.body.PASSKEY === STATION_PASSKEY) {
        const last = decodeStationData(req.body);
        const timestamp = new Date(last.timestamp);
        const now = Date.now();
        const diff = now - timestamp.getTime();
        if (diff < 3600000) {
            socketEmitData('station', last);
            const multi = redisClient.multi();
            multi.set('station', JSON.stringify(last));
            multi.zadd('station-store', timestamp.getTime(), JSON.stringify(last));
            multi.exec(function (err, replies) {
                console.log(replies); // 101, 51
                redisClient.zrangebyscore('station-trend', now - 3600000, now, function (err, result) {
                    socketEmitData('stationTrend', transformStationTrendData(result));
                });
            });
        }
    } else {
        console.error('Wrong PASSKEY' + req.body.PASSKEY);
    }
    res.sendStatus(200);
})

app.post('/setDomData', function (req: any, res: any) {
    console.info('/setDomData');
    if (req.body.PASSKEY === DOM_PASSKEY) {
        const last = req.body;
        const timestamp = new Date(last.timestamp);
        const now = Date.now();
        const diff = now - timestamp.getTime();
        if (diff < 3600000) {
            socketEmitData('dom', last);
            const multi = redisClient.multi();
            multi.set('dom', JSON.stringify(last));
            multi.zadd('dom-store', timestamp.getTime(), JSON.stringify(last));
            multi.zadd('dom-os', timestamp.getTime(), JSON.stringify(last));
            multi.zremrangebyscore('dom-os', 0, now - 3600000);
            multi.exec(function (err, replies) {
                console.log(replies); // 101, 51
                redisClient.zrangebyscore('dom-os', now - 3600000, now, function (err, result) {
                    socketEmitData('domTrend', transformDomTrendData(result));
                });
            });
        }
    } else {
        console.error('Wrong PASSKEY' + req.body.PASSKEY);
    }
    res.sendStatus(200);
})

app.get('/api/getUserProfile', function (req: any, res: any) {
    console.info('/getUserProfile');
    if (req.headers.authorization) {
        const user = verifyToken(req.headers.authorization.substr(7));
        if (user !== null) {
            res.type('application/json');
            return res.json(user);
        }
        else {
            res.status(401).send('auth issue');
        }
    }
    else {
        res.status(401).send('auth issue');
    }
})

app.get('/api/getLastData/:uuid', function (req: any, res: any) {
    console.info('/getLastData/' + req.params.uuid);
    if (req.headers.authorization && verifyToken(req.headers.authorization.substr(7)) !== null) {
        res.type('application/json');
        redisClient.get(req.params.uuid, function (err: any, reply: any) {
            return res.json(JSON.parse(reply));
        });
    }
    else {
        res.status(401).send('auth issue');
    }
})

function transformStationTrendData(data: any) {
    const tmp = new StationTrendData();
    let prev = 0;
    data.forEach((item: any) => {
        let value: StationData = JSON.parse(item);
        let date = new Date(value.timestamp);
        let time = date.getTime();
        if (time - prev >= 60000) {
            tmp.timestamp.push(value.timestamp);
            tmp.tempin.push(value.tempin);
            tmp.humidityin.push(value.humidityin);
            tmp.temp.push(value.temp);
            tmp.humidity.push(value.humidity);
            tmp.pressurerel.push(value.pressurerel);
            tmp.windgust.push(value.windgust);
            tmp.windspeed.push(value.windspeed);
            tmp.winddir.push(value.winddir);
            tmp.solarradiation.push(value.solarradiation);
            tmp.uv.push(value.uv);
            tmp.rainrate.push(value.rainrate);
            prev = time;
        }
    });
    return tmp;
}

function transformDomTrendData(data: any) {
    const tmp = new DomTrendData();
    data.forEach((item: any) => {
        let value = JSON.parse(item);
        tmp.timestamp.push(value.timestamp);
        tmp.temp.push(value.vonku.temp);
        tmp.humidity.push(value.vonku.humidity);
        tmp.rain.push(value.vonku.rain);
        tmp.obyvacka_vzduch.push(value.obyvacka_vzduch.temp);
        tmp.obyvacka_podlaha.push(value.obyvacka_podlaha.temp);
        tmp.pracovna_vzduch.push(value.pracovna_vzduch.temp);
        tmp.pracovna_podlaha.push(value.pracovna_podlaha.temp);
        tmp.spalna_vzduch.push(value.spalna_vzduch.temp);
        tmp.spalna_podlaha.push(value.spalna_podlaha.temp);
        tmp.chalani_vzduch.push(value.chalani_vzduch.temp);
        tmp.chalani_podlaha.push(value.chalani_podlaha.temp);
        tmp.petra_vzduch.push(value.petra_vzduch.temp);
        tmp.petra_podlaha.push(value.petra_podlaha.temp);
    });
    return tmp;
}

app.get('/api/getTrendData/:uuid', function (req: any, res: any) {
    console.info('/getTrendData/' + req.params.uuid);
    if (req.headers.authorization && verifyToken(req.headers.authorization.substr(7)) !== null) {
        res.type('application/json');
        const now = Date.now();
        if (req.params.uuid === 'station') {
            redisClient.zrangebyscore('station-trend', now - 3600000, now, function (err, result) {
                return res.json(transformStationTrendData(result));
            });
        }
        else if (req.params.uuid === 'dom') {
            redisClient.zrangebyscore('dom-os', now - 3600000, now, function (err, result) {
                return res.json(transformDomTrendData(result));
            });
        }
    }
    else {
        res.status(401).send('auth issue');
    }
})

io.on('connection', function (socket: any) {
    function emitLastestStationData() {
        const now = Date.now();
        redisClient.get('station', function (err: any, reply: any) {
            socket.emit('station', JSON.parse(reply));
            redisClient.zrangebyscore('station-trend', now - 3600000, now, function (err, result) {
                socket.emit('stationTrend', transformStationTrendData(result));
            });
        });
    }

    console.log('a user connected', socket.id);

    socket.on('station', function (message: any) {
        console.info('station', message, 'emit latest data', socket.id);
        emitLastestStationData();
    });

    socket.on('disconnect', function () {
        const index = sockets.indexOf(socket);
        if (index > -1) {
            sockets.splice(index, 1);
        }
        console.log('A user disconnected', socket.id);
        console.info('sockets', sockets.length);
    });

    console.info('emit latest dom data');
    sockets.push(socket);

    const now = Date.now();
    redisClient.get('dom', function (err: any, reply: any) {
        socket.emit('dom', JSON.parse(reply));
        redisClient.zrangebyscore('dom-os', now - 3600000, now, function (err, result) {
            socket.emit('domTrend', transformDomTrendData(result));
        });
    });

    console.info('sockets', sockets.length);
});

var server = http.listen(8082, function () {
    //    const host = server.address().address;
    const { port } = server.address() as AddressInfo;

    console.log("Listening at http://%s:%s", 'localhost', port);
})
