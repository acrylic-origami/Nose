const noble = require('noble');
const Rx = require('rxjs');
const fs = require('fs');

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

// generic util
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

// specific util
function encodeCommand(cmd) {
	const encoded = new TextEncoder().encode(`X${cmd}\n`);
	encoded[0] = encoded.length - 1;
	return encoded;
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

module.exports = {
	channelNames: ['TP9', 'AF7', 'AF8', 'TP10', 'AUX'],
	send_command: function(ctrl_service, cmd, no_response = true) {
		const P = promisify(ctrl, 'write');
		ctrl.write(Buffer.from(encodeCommand(cmd)), no_response);
		return P;
	},
	FFT: function(uuid, FFT_WINDOW=128, EDMSE_DECAY=0.2) {
		return this.raw(uuid)[0].then(S => S.pipe(
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
			filter(v => v != null),
			map(([f, y]) => {
				const fft = new FFT(y.length, 1/f);
				fft.forward(y);
				return fft;
			})
		));
	},
	raw: function(uuid) {
		const F_s_ctrl = Rx.fromEvent(noble, 'discover')
		  .pipe(
		  	takeWhile(p => p.uuid !== uuid, true),
		  	last()
	  	).toPromise().then(p => {
		  	const ret = promisify(p, 'connect')
	  			.then(() => {
	  				const P = promisify(p, 'servicesDiscover');
	  				p.discoverServices(['fe8d']);
	  				return P;
	  			})
	  			.then(([[s]]) => {
	  				const P = promisify(s, 'characteristicsDiscover');
					s.discoverCharacteristics(CONTROL_CHARACTERISTIC);
					return P.then(([[ctrl]]) => [s, ctrl]);
	  			})
	  		p.connect();
	  		return ret;
		});
		if(noble.state === 'poweredOn')
			noble.startScanning([], true, console.log);
		else
			noble.on('stateChange', state => {
				switch(state) {
					case 'poweredOn':
						noble.startScanning([], true, console.log);
						break;
				}
			});
		
		const F_EEG = F_s_ctrl.then(([s, ctrl]) => {
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
						char_scan.pipe(
							last(),
							map(chars => chars.map(char => {
								const ret = Rx.fromEvent(char, 'data')
				  		  			.pipe(
				  		  				map(([d]) => decodeEEGSamples(d.slice(2))))
				  		  		char.subscribe();
				  		  		char.read();
				  		  		return ret;
			  		  		}))
		  		  		);
						s.discoverCharacteristics(EEG_CHARACTERISTICS);
					});
		});
		return [F_EEG, F_s_ctrl];
	}
};