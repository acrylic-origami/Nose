const noble = require('noble');
const Rx = require('rxjs');
const fs = require('fs');
const express = require('express');
const app = express();
// app.use(express.static('public/'));
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const http = require('http').Server(app);
const io = require('socket.io')(http);

const { FFT_WINDOW, EDMSE_DECAY, FREQS } = require('./consts');
const { FFT, IIRFilter } = require('dsp.js');
// const fft = require('jsfft');

const { map, scan, takeWhile, last, startWith, bufferTime, filter, skip } = require('rxjs/operators');

const TextEncoder = require('util').TextEncoder;

const CONTROL_CHARACTERISTIC = ['273e00014c4d454d96bef03bac821358'];
const TELEMETRY_CHARACTERISTIC = ['273e000b4c4d454d96bef03bac821358'];
const GYROSCOPE_CHARACTERISTIC = ['273e00094c4d454d96bef03bac821358'];
const ACCELEROMETER_CHARACTERISTIC = ['273e000a4c4d454d96bef03bac821358'];
const EEG_CHARACTERISTICS = [
    '273e00034c4d454d96bef03bac821358',
    '273e00044c4d454d96bef03bac821358',
    '273e00054c4d454d96bef03bac821358',
    '273e00064c4d454d96bef03bac821358',
    '273e00074c4d454d96bef03bac821358',
];
const channelNames = ['TP9', 'AF7', 'AF8', 'TP10', 'AUX'];

const subjs = new Map();
io.on('connection', socket => {
	const subj = new Rx.Subject();
	subj.pipe(bufferTime(1E3), filter(v => v.length > 0))
	    .subscribe(socket.emit.bind(socket, 'data'));
	
	subjs.set(socket.id, subj);
	socket.on('disconnect', _ => subjs.delete(socket.id));
});
http.listen(3000);
// ---

function fallable_promisify(eventer, ev, ...args) {
	return new Promise((resolve, reject) => {
		(typeof eventer.once === 'function' ? eventer.once : eventer.on).call(eventer, [ev].concat(args).concat([(e, ...rest) => {
				if(e) reject(e);
				else resolve(...rest);
			}]));
	});
}
function promisify(eventer, ev, ...args) {
	console.log([ev].concat(args));
	return new Promise(resolve => {
		(typeof eventer.once === 'function' ? eventer.once : eventer.on).apply(eventer, [ev].concat(args).concat([(...rest) => resolve(rest)]))
	});
}
function now() {
	const t_ = process.hrtime();
	return t_[0] + t_[1] * 1E-9;
}

const devices = new Set();
Rx.fromEvent(noble, 'discover')
  .subscribe(p => {
	if(!devices.has(p.address) && !devices.has('00:55:da:b7:0b:a0')) {
		devices.add(p.address);
		console.log(p.address, p.advertisement.localName);
		if(p.advertisement.localName === 'Muse-0BA0') {
			promisify(p, 'connect')
				.then(() => {
					const P = promisify(p, 'servicesDiscover');
					p.discoverServices(['fe8d']);
					return P;
				})
				.then(([[s]]) => {
					const P = promisify(s, 'characteristicsDiscover').then(([[ctrl]]) => {
							// ctrl.once('notify', console.log)
							// ctrl.on('data', d => console.log(d.length, d, d.toString('ascii')));
							// ctrl.subscribe();
							// send_command(ctrl, 'v1').then(console.log);
							// return;
							['h', 'p21', 's', 'd'].reduce((acc, v) => acc.then(() => send_command(ctrl, v)), Promise.resolve())
								.then(() => {
									const char_scan = Rx.fromEvent(s, 'characteristicsDiscover').pipe(
										scan((acc, chars) => {
											for(const char of chars)
												acc.set(char.uuid, char);
											return acc;
										}, new Map()),
										takeWhile(chars => chars.size < EEG_CHARACTERISTICS.length, true)
									)
									// char_scan.subscribe(console.log);
									char_scan.pipe(last()).subscribe(chars => {
									  	const char = chars.get(EEG_CHARACTERISTICS[2]);
									  	const W = fs.createWriteStream(process.argv[2] || 'out.csv');
									  	
									  	const make_mult_3_bytes = [
						  		  		  	scan(([_, res], [v]) => {
						  		  		  		// console.log(res, v);
						  		  		  		console.log(v);
						  			  		  	const data = Buffer.concat([res, v]);
						  			  		  	return [
						  			  		  		data.slice(0, data.length - (data.length % 3)),
						  			  		  		data.slice(data.length - (data.length % 3))
						  		  		  		];
						  		  			}, [Buffer.alloc(0), Buffer.alloc(0)])
					  		  		  	]; // unused pipeline atm because the 20-byte buffer so far doesn't act this way; just has two bytes for index and 18 for data. If the buffer is clipped, then the data should just be discarded
						  		  		const packets = Rx.fromEvent(char, 'data')
						  		  			.pipe(
						  		  				map(([d]) => decodeEEGSamples(d.slice(2))),
							  		  		  	scan(([[prev, _], avg], v) => {
							  		  		  		const t = now();
							  		  		  		return [[t, v], (t - prev) * EDMSE_DECAY + (avg !== null ? avg : (t - prev)) * (1 - EDMSE_DECAY)];
							  			  		}, [[now(), null], null]),
							  			  		skip(1),
							  			  		scan(([t0, buf, _], [packet]) => {
							  			  			buf.push.apply(buf, packet[1]);
							  			  			if(buf.length >= FFT_WINDOW) {
							  			  				return [packet[0], buf.slice(FFT_WINDOW), [Math.floor(FFT_WINDOW / (packet[0] - t0)), buf.slice(0, FFT_WINDOW)]];
							  			  			}
							  			  			else {
							  			  				return [t0, buf, null];
							  			  			}
							  			  		}, [now(), [], null]),
							  			  		map(([_, __, v]) => v),
							  			  		filter(v => v != null)
					  		  				);
						  		  		packets.subscribe(([f, y]) => {
						  		  			// tried IIR filters, but with naive attempt the results make no sense 
						  		  			const fft = new FFT(y.length, 1/f);
						  		  			fft.forward(y);
						  		  			// console.log(F_max)
						  		  			for(let i = Math.round(55 / f * y.length); i < 65 / f * y.length; i++) {
						  		  				fft.spectrum[i] = 0;
						  		  			}
						  		  			let attention = 0;
						  		  			const bands = [];
						  		  			for(let i = 0; i < FREQS.length-1; i++) {
						  		  				const band = fft.spectrum.slice(
						  		  					FREQS[i] / f * fft.spectrum.length,
						  		  					FREQS[i+1] / f * fft.spectrum.length
					  		  					);
					  		  					bands.push(Math.sqrt(band.reduce((a, v) => a + v*v, 0)));
					  		  					// attention += ATTN_WEIGHTS[i] * band;
						  		  			}
						  		  			console.log(bands);
						  		  			for(const [socket_id, subj] of subjs)
						  		  				subj.next(attention);
						  		  		});
						  		  		char.subscribe();
						  		  		char.read();
									})
									s.discoverCharacteristics(EEG_CHARACTERISTICS);
								});
								// if we don't need the ctrl anymore, we could push this up a level
					});
					s.discoverCharacteristics(CONTROL_CHARACTERISTIC);
					return P;
				})
				// .catch(console.log);
			p.connect(console.log);
		}
	}
}, e => null);
noble.on('stateChange', state => {
	console.log(state);
	switch(state) {
		case 'poweredOn':
			noble.startScanning([], true, console.log);
			break;
	}
});
function send_command(ctrl, cmd, no_response = true) {
	const P = promisify(ctrl, 'write');
	ctrl.write(Buffer.from(encodeCommand(cmd)), no_response);
	return P;
}
function decode_data(d_) {
	D = [];
	const d = Buffer.concat([d_, Buffer.alloc(1)]);
	for(let i = 0; i < d.length - 4; i += 3) {
		const word = d.readUInt32BE(i);
		D.push((word >> 20) & 0xFFF);
		D.push((word >> 4) & 0xFFF);
	}
	return D;
}
function decodeEEGSamples(samples) {
    return decode_data(samples)
        .map((n) => 0.48828125 * (n - 0x800));
}
function encodeCommand(cmd) {
    const encoded = new TextEncoder().encode(`X${cmd}\n`);
    encoded[0] = encoded.length - 1;
    return encoded;
}