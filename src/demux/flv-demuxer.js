/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from '../utils/logger.js';
import AMF from './amf-parser.js';
import SPSParser from './sps-parser.js';
import DemuxErrors from './demux-errors.js';
import MediaInfo from '../core/media-info.js';
import {IllegalStateException} from '../utils/exception.js';

/**
 * 16位数据交换高8位和低8位
 * @param {16位无符号整型} src 
 */
function Swap16(src) {
    return (((src >>> 8) & 0xFF) |
            ((src & 0xFF) << 8));
}

/**
 * 32位数据交换高低字节顺序依次交换
 * @param {32位无符号整型} src 
 */
function Swap32(src) {
    return (((src & 0xFF000000) >>> 24) |
            ((src & 0x00FF0000) >>> 8)  |
            ((src & 0x0000FF00) << 8)   |
            ((src & 0x000000FF) << 24));
}

/**
 * 从数组中读取一个32位数
 * @param {数组} array 
 * @param {索引} index 
 */
function ReadBig32(array, index) {
    return ((array[index] << 24)     |
            (array[index + 1] << 16) |
            (array[index + 2] << 8)  |
            (array[index + 3]));
}

/**
 * FLV解封装类
 * 
 * FLV - 文件格式：
 * ----------------------------------
 * |    Header                      |
 * ----------------------------------
 * |    PreviousTagSize0            |   必须是 0
 * ----------------------------------
 * |    Tag1                        |
 * ----------------------------------
 * |    PreviousTagSize1            |   Tag1的大小
 * ----------------------------------
 * |    Tag2                        |   
 * ----------------------------------
 * |    PreviousTagSize2            |   Tag2的大小
 * ----------------------------------
 * |    Tag3                        |
 * ----------------------------------
 * |    PreviousTagSize3            |   Tag3的大小
 * ----------------------------------
 * |    ......                      |
 * ----------------------------------
 * |    ......                      |
 * ----------------------------------
 * |    TagN                        |  
 * ----------------------------------
 * |    PreviousTagSizeN            |   TagN的大小
 * ----------------------------------
 * 
 * Tag的格式：
 * ----------------------------------
 * Field        type        Comment
 * ----------------------------------
 * TAG类型      UI8         8: audio  9: video  18: script data——这里是一些描述信息。all others: reserved其他所有值未使用。
 * ----------------------------------
 * 数据大小     UI24        数据区的大小，不包括包头。包头总大小是11个字节。
 * ----------------------------------
 * 时戳         UI24        当前帧时戳，单位是毫秒。相对于FLV文件的第一个TAG时戳。第一个tag的时戳总是0。——不是时戳增量，rtmp中是时戳增量。
 * ----------------------------------
 * 时戳扩展字段  UI8        如果时戳大于0xFFFFFF，将会使用这个字节。这个字节是时戳的高8位，上面的三个字节是低24位。
 * ----------------------------------
 * 流ID         U24         总是0
 * ----------------------------------
 * 数据区       UI8[n]      
 * ----------------------------------
 * 
 * 
 */
class FLVDemuxer {

    /**
     * 构造函数
     * @param {probeData} probeData 
     * @param {config} config 
     */
    constructor(probeData, config) {

        // 初始化TAG
        this.TAG = 'FLVDemuxer';

        // 保存配置
        this._config = config;

        this._onError = null;
        this._onMediaInfo = null;
        this._onMetaDataArrived = null;
        this._onScriptDataArrived = null;
        this._onTrackMetadata = null;
        this._onDataAvailable = null;

        this._dataOffset = probeData.dataOffset;
        this._firstParse = true;
        this._dispatch = false;

        this._hasAudio = probeData.hasAudioTrack;
        this._hasVideo = probeData.hasVideoTrack;

        this._hasAudioFlagOverrided = false;
        this._hasVideoFlagOverrided = false;

        this._audioInitialMetadataDispatched = false;
        this._videoInitialMetadataDispatched = false;

        this._mediaInfo = new MediaInfo();
        this._mediaInfo.hasAudio = this._hasAudio;
        this._mediaInfo.hasVideo = this._hasVideo;
        this._metadata = null;
        this._audioMetadata = null;
        this._videoMetadata = null;

        this._naluLengthSize = 4;
        this._timestampBase = 0;  // int32, in milliseconds
        this._timescale = 1000;
        this._duration = 0;  // int32, in milliseconds
        this._durationOverrided = false;
        this._referenceFrameRate = {
            fixed: true,
            fps: 23.976,
            fps_num: 23976,
            fps_den: 1000
        };

        this._flvSoundRateTable = [5500, 11025, 22050, 44100, 48000];

        this._mpegSamplingRates = [
            96000, 88200, 64000, 48000, 44100, 32000,
            24000, 22050, 16000, 12000, 11025, 8000, 7350
        ];

        this._mpegAudioV10SampleRateTable = [44100, 48000, 32000, 0];
        this._mpegAudioV20SampleRateTable = [22050, 24000, 16000, 0];
        this._mpegAudioV25SampleRateTable = [11025, 12000, 8000,  0];

        this._mpegAudioL1BitRateTable = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1];
        this._mpegAudioL2BitRateTable = [0, 32, 48, 56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, 384, -1];
        this._mpegAudioL3BitRateTable = [0, 32, 40, 48,  56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, -1];

        // 初始化视频轨道和音频轨道
        this._videoTrack = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
        this._audioTrack = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};

        this._littleEndian = (function () {
            let buf = new ArrayBuffer(2);
            (new DataView(buf)).setInt16(0, 256, true);  // little-endian write
            return (new Int16Array(buf))[0] === 256;  // platform-spec read, if equal then LE
        })();
    }

    /**
     * 析构函数
     */
    destroy() {
        this._mediaInfo = null;
        this._metadata = null;
        this._audioMetadata = null;
        this._videoMetadata = null;
        this._videoTrack = null;
        this._audioTrack = null;

        this._onError = null;
        this._onMediaInfo = null;
        this._onMetaDataArrived = null;
        this._onScriptDataArrived = null;
        this._onTrackMetadata = null;
        this._onDataAvailable = null;
    }

    /**
     * 解析指定的buffer中的flv文件头 Header的信息格式
     * 
     *  Field           | type |    Comment
     * ————————————————————————————————————————————————————————————————————————     
     *  [0] 签名        | UI8  |    ’F’(0X46)
     * ————————————————————————————————————————————————————————————————————————    
     *  [1] 签名        | UI8  |    ‘L’(0X4C)
     * ————————————————————————————————————————————————————————————————————————    
     *  [2] 签名        | UI8  |    ‘V’(0x56)
     * ————————————————————————————————————————————————————————————————————————    
     *  [3] 版本        | UI8  |    FLV的版本：0x01 表示FLV版本是1
     * ————————————————————————————————————————————————————————————————————————    
     *  [4] 保留字段    | UB5  |    前五位必须是0
     * ————————————————————————————————————————————————————————————————————————    
     *  [4] 是否有音频流 | UB1  |    音频流是否存在标志
     * ————————————————————————————————————————————————————————————————————————    
     *  [4]保留字段     | UB1  |    必须是0
     * ————————————————————————————————————————————————————————————————————————    
     *  [4]是否有视频流  | UB1  |    视频流是否存在标志
     * ————————————————————————————————————————————————————————————————————————    
     *  [5-8]文件头大小  | UI32 |   FLV版本1时填写9，表明的是FLV头的大小，为后期的FLV版本扩展使用。包括这四个字节。
     *                            数据的起始位置就是从文件开头偏移这么多的大小。
     * ————————————————————————————————————————————————————————————————————————
     * 
     * @param {buffer} buffer 
     * 
     * @return flv的头信息
     *  {
     *      match: true,  // true - 匹配到flv格式
     *      consumed: offset, //  消费的字节数
     *      dataOffset: offset,   // 数据新的偏移位置
     *      hasAudioTrack: hasAudio,  // 是否有音频标志
     *      hasVideoTrack: hasVideo   // 是否有视频标志
     *  }
     *  或者
     *  {
     *      match: false  // false - 未匹配上
     *  }
     */
    static probe(buffer) {
        let data = new Uint8Array(buffer);
        let mismatch = {match: false};

        // ‘F’-‘L’-‘V’-‘version:1’判断
        if (data[0] !== 0x46 || data[1] !== 0x4C || data[2] !== 0x56 || data[3] !== 0x01) {
            return mismatch;
        }

        // 音频和视频标志解析
        let hasAudio = ((data[4] & 4) >>> 2) !== 0;
        let hasVideo = (data[4] & 1) !== 0;

        // flv头大小读取
        let offset = ReadBig32(data, 5);

        if (offset < 9) {
            return mismatch;
        }

        // 返回解析后的头信息
        return {
            match: true,
            consumed: offset,
            dataOffset: offset,
            hasAudioTrack: hasAudio,
            hasVideoTrack: hasVideo
        };
    }

    /**
     * 绑定数据源 ： 对于demuxer来说源为io
     * 
     * IO-Loader调用onDataArrival将数据分发给Demuxer的parseChunks函数进行处理
     * 
     * @param {} loader IOloader
     */
    bindDataSource(loader) {
        // 设定loader的数据到达处理函数
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    // prototype: function(type: string, metadata: any): void
    get onTrackMetadata() {
        return this._onTrackMetadata;
    }

    // 设置 demuxer的 消费者 mp4-muxer接收元数据信息
    set onTrackMetadata(callback) {
        this._onTrackMetadata = callback;
    }

    // prototype: function(mediaInfo: MediaInfo): void
    get onMediaInfo() {
        return this._onMediaInfo;
    }

    set onMediaInfo(callback) {
        this._onMediaInfo = callback;
    }

    get onMetaDataArrived() {
        return this._onMetaDataArrived;
    }

    set onMetaDataArrived(callback) {
        this._onMetaDataArrived = callback;
    }

    get onScriptDataArrived() {
        return this._onScriptDataArrived;
    }

    set onScriptDataArrived(callback) {
        this._onScriptDataArrived = callback;
    }

    // prototype: function(type: number, info: string): void
    get onError() {
        return this._onError;
    }

    set onError(callback) {
        this._onError = callback;
    }

    // prototype: function(videoTrack: any, audioTrack: any): void
    get onDataAvailable() {
        return this._onDataAvailable;
    }

    set onDataAvailable(callback) {
        this._onDataAvailable = callback;
    }

    // timestamp base for output samples, must be in milliseconds
    get timestampBase() {
        return this._timestampBase;
    }

    set timestampBase(base) {
        this._timestampBase = base;
    }

    get overridedDuration() {
        return this._duration;
    }

    // Force-override media duration. Must be in milliseconds, int32
    set overridedDuration(duration) {
        this._durationOverrided = true;
        this._duration = duration;
        this._mediaInfo.duration = duration;
    }

    // Force-override audio track present flag, boolean
    set overridedHasAudio(hasAudio) {
        this._hasAudioFlagOverrided = true;
        this._hasAudio = hasAudio;
        this._mediaInfo.hasAudio = hasAudio;
    }

    // Force-override video track present flag, boolean
    set overridedHasVideo(hasVideo) {
        this._hasVideoFlagOverrided = true;
        this._hasVideo = hasVideo;
        this._mediaInfo.hasVideo = hasVideo;
    }

    /**
     * 重置MediaInfo
     */
    resetMediaInfo() {
        this._mediaInfo = new MediaInfo();
    }

    /**
     * 检查初始的元信息是否已经分发给消费者-mp4remuxer
     */
    _isInitialMetadataDispatched() {
        if (this._hasAudio && this._hasVideo) {  // both audio & video
            return this._audioInitialMetadataDispatched && this._videoInitialMetadataDispatched;
        }
        if (this._hasAudio && !this._hasVideo) {  // audio only
            return this._audioInitialMetadataDispatched;
        }
        if (!this._hasAudio && this._hasVideo) {  // video only
            return this._videoInitialMetadataDispatched;
        }
        return false;
    }

    // function parseChunks(chunk: ArrayBuffer, byteStart: number): number;
    /**
     * 接收ioLoadre的分块数据，并进行处理
     * @param {chunk - ArrayBuffer} chunk 数据块数组缓冲区
     * @param {byteStart - number} byteStart 数据起始的位置
     * 
     * @return {offset - number} offset： 解析后的有效数据起始位置
     */
    parseChunks(chunk, byteStart) {
        if (!this._onError || !this._onMediaInfo || !this._onTrackMetadata || !this._onDataAvailable) {
            throw new IllegalStateException('Flv: onError & onMediaInfo & onTrackMetadata & onDataAvailable callback must be specified');
        }

        // 偏移量计数器
        let offset = 0;
        let le = this._littleEndian;

        // 如果是从缓冲区的头开始，则表示缓冲区中有FLV的头信息
        if (byteStart === 0) {  // buffer with FLV header
            if (chunk.byteLength > 13) {
                // 解析 flv的头信息
                let probeData = FLVDemuxer.probe(chunk);

                // 跳过FLV头
                offset = probeData.dataOffset;
            } else {
                return 0;
            }
        }

        // 第一次解析处理
        if (this._firstParse) {  // handle PreviousTagSize0 before Tag1
            // 清除第一次解析标志
            this._firstParse = false;
            if (byteStart + offset !== this._dataOffset) {
                Log.w(this.TAG, 'First time parsing but chunk byteStart invalid!');
            }

            // 解析第一个tag的prevTagSize，该值必须为0
            let v = new DataView(chunk, offset);
            let prevTagSize0 = v.getUint32(0, !le);
            if (prevTagSize0 !== 0) {
                Log.w(this.TAG, 'PrevTagSize0 !== 0 !!!');
            }
            // 跳过size的4个字节
            offset += 4;
        }

        // 循环处理
        while (offset < chunk.byteLength) {
            // 设置分发标志
            this._dispatch = true;

            let v = new DataView(chunk, offset);

            // 检查缓冲区是否满足解析需求
            if (offset + 11 + 4 > chunk.byteLength) {
                // data not enough for parsing an flv tag
                break;
            }

            // 读取tag的类型
            let tagType = v.getUint8(0);
            // 读取tag的数据大小
            let dataSize = v.getUint32(0, !le) & 0x00FFFFFF;

            // 检查缓冲区是否满足解析需求
            if (offset + 11 + dataSize + 4 > chunk.byteLength) {
                // data not enough for parsing actual data body
                break;
            }

            // 仅处理 8-音频；9-视频；18-脚本类型的tag
            if (tagType !== 8 && tagType !== 9 && tagType !== 18) {
                Log.w(this.TAG, `Unsupported tag type ${tagType}, skipped`);
                // consume the whole tag (skip it)
                offset += 11 + dataSize + 4;

                // 继续处理后续的tag
                continue;
            }

            // 获取时间戳
            let ts2 = v.getUint8(4);
            let ts1 = v.getUint8(5);
            let ts0 = v.getUint8(6);
            let ts3 = v.getUint8(7);

            let timestamp = ts0 | (ts1 << 8) | (ts2 << 16) | (ts3 << 24);

            // 读取流Id，必须为0
            let streamId = v.getUint32(7, !le) & 0x00FFFFFF;
            if (streamId !== 0) {
                Log.w(this.TAG, 'Meet tag which has StreamID != 0!');
            }

            let dataOffset = offset + 11;

            // 根据类型解析对应的tag
            switch (tagType) {
                case 8:  // Audio
                    // 解析音频tag
                    this._parseAudioData(chunk, dataOffset, dataSize, timestamp);
                    break;
                case 9:  // Video
                    // 解析视频tag
                    this._parseVideoData(chunk, dataOffset, dataSize, timestamp, byteStart + offset);
                    break;
                case 18:  // ScriptDataObject
                    // 解析脚本tag
                    this._parseScriptData(chunk, dataOffset, dataSize);
                    break;
            }

            // 读取下一个tag的PrevTagSize和当前的tag大小对比进行验证
            let prevTagSize = v.getUint32(11 + dataSize, !le);
            if (prevTagSize !== 11 + dataSize) {
                Log.w(this.TAG, `Invalid PrevTagSize ${prevTagSize}`);
            }

            offset += 11 + dataSize + 4;  // tagBody + dataSize + prevTagSize
        }

        // 分发解析出来的帧数据给消费者 mp4remuxer
        // dispatch parsed frames to consumer (typically, the remuxer)
        if (this._isInitialMetadataDispatched()) {
            if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                // 分发给 mp4remuxer
                this._onDataAvailable(this._audioTrack, this._videoTrack);
            }
        }

        return offset;  // consumed bytes, just equals latest offset index
    }

    /**
     * 解析flv的脚本tag
     * @param {数组缓冲区} arrayBuffer 
     * @param {有效数据在缓冲区的开始位置} dataOffset 
     * @param {数据的有效长度} dataSize 
     */
    _parseScriptData(arrayBuffer, dataOffset, dataSize) {
        // 解析amf
        let scriptData = AMF.parseScriptData(arrayBuffer, dataOffset, dataSize);

        if (scriptData.hasOwnProperty('onMetaData')) {
            if (scriptData.onMetaData == null || typeof scriptData.onMetaData !== 'object') {
                Log.w(this.TAG, 'Invalid onMetaData structure!');
                return;
            }
            if (this._metadata) {
                Log.w(this.TAG, 'Found another onMetaData tag!');
            }
            this._metadata = scriptData;
            let onMetaData = this._metadata.onMetaData;

            if (this._onMetaDataArrived) {
                this._onMetaDataArrived(Object.assign({}, onMetaData));
            }

            if (typeof onMetaData.hasAudio === 'boolean') {  // hasAudio
                if (this._hasAudioFlagOverrided === false) {
                    this._hasAudio = onMetaData.hasAudio;
                    this._mediaInfo.hasAudio = this._hasAudio;
                }
            }
            if (typeof onMetaData.hasVideo === 'boolean') {  // hasVideo
                if (this._hasVideoFlagOverrided === false) {
                    this._hasVideo = onMetaData.hasVideo;
                    this._mediaInfo.hasVideo = this._hasVideo;
                }
            }
            if (typeof onMetaData.audiodatarate === 'number') {  // audiodatarate
                this._mediaInfo.audioDataRate = onMetaData.audiodatarate;
            }
            if (typeof onMetaData.videodatarate === 'number') {  // videodatarate
                this._mediaInfo.videoDataRate = onMetaData.videodatarate;
            }
            if (typeof onMetaData.width === 'number') {  // width
                this._mediaInfo.width = onMetaData.width;
            }
            if (typeof onMetaData.height === 'number') {  // height
                this._mediaInfo.height = onMetaData.height;
            }
            if (typeof onMetaData.duration === 'number') {  // duration
                if (!this._durationOverrided) {
                    let duration = Math.floor(onMetaData.duration * this._timescale);
                    this._duration = duration;
                    this._mediaInfo.duration = duration;
                }
            } else {
                this._mediaInfo.duration = 0;
            }
            if (typeof onMetaData.framerate === 'number') {  // framerate
                let fps_num = Math.floor(onMetaData.framerate * 1000);
                if (fps_num > 0) {
                    let fps = fps_num / 1000;
                    this._referenceFrameRate.fixed = true;
                    this._referenceFrameRate.fps = fps;
                    this._referenceFrameRate.fps_num = fps_num;
                    this._referenceFrameRate.fps_den = 1000;
                    this._mediaInfo.fps = fps;
                }
            }
            if (typeof onMetaData.keyframes === 'object') {  // keyframes
                this._mediaInfo.hasKeyframesIndex = true;
                let keyframes = onMetaData.keyframes;
                this._mediaInfo.keyframesIndex = this._parseKeyframesIndex(keyframes);
                onMetaData.keyframes = null;  // keyframes has been extracted, remove it
            } else {
                this._mediaInfo.hasKeyframesIndex = false;
            }
            this._dispatch = false;
            this._mediaInfo.metadata = onMetaData;
            Log.v(this.TAG, 'Parsed onMetaData');
            if (this._mediaInfo.isComplete()) {
                this._onMediaInfo(this._mediaInfo);
            }
        }

        // 分发script数据
        if (Object.keys(scriptData).length > 0) {
            if (this._onScriptDataArrived) {
                this._onScriptDataArrived(Object.assign({}, scriptData));
            }
        }
    }

    /**
     * 解析关键帧索引
     * @param {关键帧} keyframes 
     */
    _parseKeyframesIndex(keyframes) {
        let times = [];
        let filepositions = [];

        // ignore first keyframe which is actually AVC Sequence Header (AVCDecoderConfigurationRecord)
        for (let i = 1; i < keyframes.times.length; i++) {
            let time = this._timestampBase + Math.floor(keyframes.times[i] * 1000);
            times.push(time);
            filepositions.push(keyframes.filepositions[i]);
        }

        return {
            times: times,
            filepositions: filepositions
        };
    }

    /**
     * 解析音频数据
     * ------------------------------------------------------------------------
     * Field        type        Comment
     * ------------------------------------------------------------------------
     * 音频格式     UB4          0 = Linear PCM, platform endian
     *                          1 = ADPCM
     *                          2 = MP3
     *                          3 = Linear PCM, little endian
     *                          4 = Nellymoser 16-kHz mono
     *                          5 = Nellymoser 8-kHz mono
     *                          6 = Nellymoser
     *                          7 = G.711 A-law logarithmic PCM
     *                          8 = G.711 mu-law logarithmic PCM 9 = reserved
     *                          10 = AAC
     *                          11 = Speex
     *                          14 = MP3 8-Khz
     *                          15 = Device-specific sound
     *                          7, 8, 14, and 15：内部保留使用。
     *                          flv是不支持g711a的，如果要用，可能要用线性音频。
     * ------------------------------------------------------------------------
     * 采样率       UB2         For AAC: always 3
     *                          0 = 5.5-kHz
     *                          1 = 11-kHz
     *                          2 = 22-kHz
     *                          3 = 44-kHz
     * ------------------------------------------------------------------------
     * 采样大小     UB1          0 = snd8Bit
     *                          1 = snd16Bit
     * ------------------------------------------------------------------------
     * 声道         UB1         0=单声道
     *                          1=立体声,双声道。AAC永远是1
     * ------------------------------------------------------------------------
     * 声音数据     UI8[N]	    如果是PCM线性数据，存储的时候每个16bit小端存储，有符号。
     *                          如果音频格式是AAC，则存储的数据是AAC AUDIO DATA，否则为线性数组。
     * ------------------------------------------------------------------------
     * 
     * @param {缓冲区数组} arrayBuffer 
     * @param {偏移} dataOffset 
     * @param {数据大小} dataSize 
     * @param {时间戳} tagTimestamp 
     */
    _parseAudioData(arrayBuffer, dataOffset, dataSize, tagTimestamp) {
        if (dataSize <= 1) {
            Log.w(this.TAG, 'Flv: Invalid audio packet, missing SoundData payload!');
            return;
        }

        if (this._hasAudioFlagOverrided === true && this._hasAudio === false) {
            // If hasAudio: false indicated explicitly in MediaDataSource,
            // Ignore all the audio packets
            return;
        }

        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        // 读取第一个字节
        let soundSpec = v.getUint8(0);

        // 获取第一个字节的高4位 - 音频格式
        let soundFormat = soundSpec >>> 4;
        // 判断是否为 2-mp3或者10-AAC，如果不是直接返回
        if (soundFormat !== 2 && soundFormat !== 10) {  // MP3 or AAC
            this._onError(DemuxErrors.CODEC_UNSUPPORTED, 'Flv: Unsupported audio codec idx: ' + soundFormat);
            return;
        }

        // 音频采样率
        let soundRate = 0;
        // 读取第一个字节的2-3位，音频采样率索引
        // For AAC: always 3
        // 0 = 5.5-kHz
        // 1 = 11-kHz
        // 2 = 22-kHz
        // 3 = 44-kHz
        let soundRateIndex = (soundSpec & 12) >>> 2;
        if (soundRateIndex >= 0 && soundRateIndex <= 4) {
            // 从采样率表中获取实际采样率值
            soundRate = this._flvSoundRateTable[soundRateIndex];
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid audio sample rate idx: ' + soundRateIndex);
            return;
        }

        // 读取采样大小
        // 0 = snd8Bit
        // 1 = snd16Bit
        let soundSize = (soundSpec & 2) >>> 1;  // unused
        // 读取声道数
        // 0=单声道
        // 1=立体声,双声道。
        // AAC永远是1
        let soundType = (soundSpec & 1);

        // 一个字节的音频头读取完成
        ////////////////////////////////////////////////////


        let meta = this._audioMetadata;
        let track = this._audioTrack;

        if (!meta) {
            if (this._hasAudio === false && this._hasAudioFlagOverrided === false) {
                this._hasAudio = true;
                this._mediaInfo.hasAudio = true;
            }

            // initial metadata
            // 初始化 音频的metadata
            meta = this._audioMetadata = {};
            meta.type = 'audio';
            meta.id = track.id;
            meta.timescale = this._timescale;
            meta.duration = this._duration;
            meta.audioSampleRate = soundRate;
            meta.channelCount = (soundType === 0 ? 1 : 2);
        }

        // 解析音频数据部分
        if (soundFormat === 10) {  // AAC
            // 解析aac数据 -- 跳过1字节的音频头
            let aacData = this._parseAACAudioData(arrayBuffer, dataOffset + 1, dataSize - 1);
            if (aacData == undefined) {
                return;
            }

            // AAC数据处理
            if (aacData.packetType === 0) {  // AAC sequence header (AudioSpecificConfig)
                // AAC 序列头 AudioSpecificConfig 处理
                if (meta.config) {
                    Log.w(this.TAG, 'Found another AudioSpecificConfig!');
                }
                // 更新 音频的metadata
                let misc = aacData.data;
                meta.audioSampleRate = misc.samplingRate;
                meta.channelCount = misc.channelCount;
                meta.codec = misc.codec;
                meta.originalCodec = misc.originalCodec;
                meta.config = misc.config;
                // The decode result of an aac sample is 1024 PCM samples
                meta.refSampleDuration = 1024 / meta.audioSampleRate * meta.timescale;
                Log.v(this.TAG, 'Parsed AudioSpecificConfig');
                
                // 不是初始的元数据，强制将解析的帧分派（或刷新）到remuxer
                if (this._isInitialMetadataDispatched()) {
                    // Non-initial metadata, force dispatch (or flush) parsed frames to remuxer
                    if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                        this._onDataAvailable(this._audioTrack, this._videoTrack);
                    }
                } else {
                    // 初始的元数据，记录标志
                    this._audioInitialMetadataDispatched = true;
                }

                // 通知mp4-remuxer 新的元数据到达
                // then notify new metadata
                this._dispatch = false;
                this._onTrackMetadata('audio', meta);

                // 更新mediaInfo
                let mi = this._mediaInfo;
                mi.audioCodec = meta.originalCodec;
                mi.audioSampleRate = meta.audioSampleRate;
                mi.audioChannelCount = meta.channelCount;
                if (mi.hasVideo) {
                    if (mi.videoCodec != null) {
                        mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                    }
                } else {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
                }

                // 检查媒体信息是否收集完成
                if (mi.isComplete()) {
                    // 通知 媒体信息收集完成
                    this._onMediaInfo(mi);
                }
            } else if (aacData.packetType === 1) {  // AAC raw frame data
                // AAC的 raw帧数据 处理
                let dts = this._timestampBase + tagTimestamp;
                let aacSample = {
                    unit: aacData.data, 
                    length: aacData.data.byteLength, 
                    dts: dts, 
                    pts: dts
                };

                // 添加到track的samples中
                track.samples.push(aacSample);
                track.length += aacData.data.length;
            } else {
                Log.e(this.TAG, `Flv: Unsupported AAC data type ${aacData.packetType}`);
            }
        } else if (soundFormat === 2) {  // MP3 暂时不看
            if (!meta.codec) {
                // We need metadata for mp3 audio track, extract info from frame header
                let misc = this._parseMP3AudioData(arrayBuffer, dataOffset + 1, dataSize - 1, true);
                if (misc == undefined) {
                    return;
                }
                meta.audioSampleRate = misc.samplingRate;
                meta.channelCount = misc.channelCount;
                meta.codec = misc.codec;
                meta.originalCodec = misc.originalCodec;
                // The decode result of an mp3 sample is 1152 PCM samples
                meta.refSampleDuration = 1152 / meta.audioSampleRate * meta.timescale;
                Log.v(this.TAG, 'Parsed MPEG Audio Frame Header');

                this._audioInitialMetadataDispatched = true;
                this._onTrackMetadata('audio', meta);

                let mi = this._mediaInfo;
                mi.audioCodec = meta.codec;
                mi.audioSampleRate = meta.audioSampleRate;
                mi.audioChannelCount = meta.channelCount;
                mi.audioDataRate = misc.bitRate;
                if (mi.hasVideo) {
                    if (mi.videoCodec != null) {
                        mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                    }
                } else {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
                }
                if (mi.isComplete()) {
                    this._onMediaInfo(mi);
                }
            }

            // This packet is always a valid audio packet, extract it
            let data = this._parseMP3AudioData(arrayBuffer, dataOffset + 1, dataSize - 1, false);
            if (data == undefined) {
                return;
            }
            let dts = this._timestampBase + tagTimestamp;
            let mp3Sample = {unit: data, length: data.byteLength, dts: dts, pts: dts};
            track.samples.push(mp3Sample);
            track.length += data.length;
        }
    }

    /**
     * 解析AAC音频数据
     * @param {缓冲区} arrayBuffer 
     * @param {数据起始位置} dataOffset 
     * @param {数据大小} dataSize 
     * 
     * @return result: {
     *  packetType, // 0-AACAudioSpecificConfig， 1-raw data
     *  data        // 
     * }
     * 
     */
    _parseAACAudioData(arrayBuffer, dataOffset, dataSize) {
        if (dataSize <= 1) {
            Log.w(this.TAG, 'Flv: Invalid AAC packet, missing AACPacketType or/and Data!');
            return;
        }

        let result = {};
        let array = new Uint8Array(arrayBuffer, dataOffset, dataSize);

        // 读取AAC的packetType保存到 result.packetType中
        result.packetType = array[0];

        // 根据AAC的packetType进行处理 
        // 0- AACAudioSpecificConfig
        // 1- raw data
        if (array[0] === 0) {
            // AACAudioSpecificConfig
            // 去掉第一个字节后解析结构保存到result.data中
            result.data = this._parseAACAudioSpecificConfig(arrayBuffer, dataOffset + 1, dataSize - 1);
        } else {
            // raw data
            // 去掉第一个字节后保存到result.data中
            result.data = array.subarray(1);
        }

        // 返回解析结果
        return result;
    }

    /**
     * 解析 AAC音频 特定配置信息
     * 
     * ------------------------------------------------------------------------
     * Field        type        Comment
     * ------------------------------------------------------------------------
     * 音频对象类型 UB5          0: Null
     *                          1: AAC Main
     *                          2: AAC LC
     *                          3: AAC SSR (Scalable Sample Rate)
     *                          4: AAC LTP (Long Term Prediction)
     *                          5: HE-AAC / SBR (Spectral Band Replication)
     *                          6: AAC Scalable
     * ------------------------------------------------------------------------
     * 采样频率(Hz) UB4          0:96000
     *                          1:88200
     *                          2:64000
     *                          3:48000
     *                          4:44100
     *                          5:32000
     *                          6:24000
     *                          7:22050
     *                          8:16000
     *                          9:12000
     *                          10:11025
     *                          11:8000
     *                          12:7350
     * ------------------------------------------------------------------------
     * 声道         UB4         声道数
     * ------------------------------------------------------------------------
     * extensionSamplingIndex     UB4     5: HE-AAC / SBR (Spectral Band Replication)
     * audioExtensionObjectType   UB5     5: HE-AAC / SBR (Spectral Band Replication)
     * ------------------------------------------------------------------------
     * 
     * @param {缓冲区} arrayBuffer 
     * @param {数据起始位置} dataOffset 
     * @param {数据大小} dataSize 
     * @return result：{
     *       config: config,
     *       samplingRate: samplingFrequence,
     *       channelCount: channelConfig,
     *       codec: 'mp4a.40.' + audioObjectType,
     *       originalCodec: 'mp4a.40.' + originalAudioObjectType
     *   }
     */
    _parseAACAudioSpecificConfig(arrayBuffer, dataOffset, dataSize) {
        let array = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        let config = null;

        /* Audio Object Type:
           0: Null
           1: AAC Main
           2: AAC LC
           3: AAC SSR (Scalable Sample Rate)
           4: AAC LTP (Long Term Prediction)
           5: HE-AAC / SBR (Spectral Band Replication)
           6: AAC Scalable
        */

        let audioObjectType = 0;
        let originalAudioObjectType = 0;
        let audioExtensionObjectType = null;
        let samplingIndex = 0;
        let extensionSamplingIndex = null;

        // 5 bits
        audioObjectType = originalAudioObjectType = array[0] >>> 3;
        // 4 bits
        samplingIndex = ((array[0] & 0x07) << 1) | (array[1] >>> 7);
        if (samplingIndex < 0 || samplingIndex >= this._mpegSamplingRates.length) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid sampling frequency index!');
            return;
        }

        let samplingFrequence = this._mpegSamplingRates[samplingIndex];

        // 4 bits
        let channelConfig = (array[1] & 0x78) >>> 3;
        if (channelConfig < 0 || channelConfig >= 8) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid channel configuration');
            return;
        }

        if (audioObjectType === 5) {  // HE-AAC?
            // 4 bits
            extensionSamplingIndex = ((array[1] & 0x07) << 1) | (array[2] >>> 7);
            // 5 bits
            audioExtensionObjectType = (array[2] & 0x7C) >>> 2;
        }

        // workarounds for various browsers
        let userAgent = self.navigator.userAgent.toLowerCase();

        if (userAgent.indexOf('firefox') !== -1) {
            // firefox: use SBR (HE-AAC) if freq less than 24kHz
            if (samplingIndex >= 6) {
                audioObjectType = 5;
                config = new Array(4);
                extensionSamplingIndex = samplingIndex - 3;
            } else {  // use LC-AAC
                audioObjectType = 2;
                config = new Array(2);
                extensionSamplingIndex = samplingIndex;
            }
        } else if (userAgent.indexOf('android') !== -1) {
            // android: always use LC-AAC
            audioObjectType = 2;
            config = new Array(2);
            extensionSamplingIndex = samplingIndex;
        } else {
            // for other browsers, e.g. chrome...
            // Always use HE-AAC to make it easier to switch aac codec profile
            audioObjectType = 5;
            extensionSamplingIndex = samplingIndex;
            config = new Array(4);

            if (samplingIndex >= 6) {
                extensionSamplingIndex = samplingIndex - 3;
            } else if (channelConfig === 1) {  // Mono channel
                audioObjectType = 2;
                config = new Array(2);
                extensionSamplingIndex = samplingIndex;
            }
        }

        config[0]  = audioObjectType << 3;
        config[0] |= (samplingIndex & 0x0F) >>> 1;
        config[1]  = (samplingIndex & 0x0F) << 7;
        config[1] |= (channelConfig & 0x0F) << 3;
        if (audioObjectType === 5) {
            config[1] |= ((extensionSamplingIndex & 0x0F) >>> 1);
            config[2]  = (extensionSamplingIndex & 0x01) << 7;
            // extended audio object type: force to 2 (LC-AAC)
            config[2] |= (2 << 2);
            config[3]  = 0;
        }

        // 返回音频配置对象
        return {
            config: config,
            samplingRate: samplingFrequence,
            channelCount: channelConfig,
            codec: 'mp4a.40.' + audioObjectType,
            originalCodec: 'mp4a.40.' + originalAudioObjectType
        };
    }

    _parseMP3AudioData(arrayBuffer, dataOffset, dataSize, requestHeader) {
        if (dataSize < 4) {
            Log.w(this.TAG, 'Flv: Invalid MP3 packet, header missing!');
            return;
        }

        let le = this._littleEndian;
        let array = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        let result = null;

        if (requestHeader) {
            if (array[0] !== 0xFF) {
                return;
            }
            let ver = (array[1] >>> 3) & 0x03;
            let layer = (array[1] & 0x06) >> 1;

            let bitrate_index = (array[2] & 0xF0) >>> 4;
            let sampling_freq_index = (array[2] & 0x0C) >>> 2;

            let channel_mode = (array[3] >>> 6) & 0x03;
            let channel_count = channel_mode !== 3 ? 2 : 1;

            let sample_rate = 0;
            let bit_rate = 0;
            let object_type = 34;  // Layer-3, listed in MPEG-4 Audio Object Types

            let codec = 'mp3';

            switch (ver) {
                case 0:  // MPEG 2.5
                    sample_rate = this._mpegAudioV25SampleRateTable[sampling_freq_index];
                    break;
                case 2:  // MPEG 2
                    sample_rate = this._mpegAudioV20SampleRateTable[sampling_freq_index];
                    break;
                case 3:  // MPEG 1
                    sample_rate = this._mpegAudioV10SampleRateTable[sampling_freq_index];
                    break;
            }

            switch (layer) {
                case 1:  // Layer 3
                    object_type = 34;
                    if (bitrate_index < this._mpegAudioL3BitRateTable.length) {
                        bit_rate = this._mpegAudioL3BitRateTable[bitrate_index];
                    }
                    break;
                case 2:  // Layer 2
                    object_type = 33;
                    if (bitrate_index < this._mpegAudioL2BitRateTable.length) {
                        bit_rate = this._mpegAudioL2BitRateTable[bitrate_index];
                    }
                    break;
                case 3:  // Layer 1
                    object_type = 32;
                    if (bitrate_index < this._mpegAudioL1BitRateTable.length) {
                        bit_rate = this._mpegAudioL1BitRateTable[bitrate_index];
                    }
                    break;
            }

            result = {
                bitRate: bit_rate,
                samplingRate: sample_rate,
                channelCount: channel_count,
                codec: codec,
                originalCodec: codec
            };
        } else {
            result = array;
        }

        return result;
    }

    /**
     * 解析视频数据
     * 
     * @param {数组缓冲区} arrayBuffer 
     * @param {数据起始位置} dataOffset 
     * @param {数据大小} dataSize 
     * @param {flv - Tag 时间戳} tagTimestamp 
     * @param {flv - Tag 位置} tagPosition 
     */
    _parseVideoData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition) {
        if (dataSize <= 1) {
            Log.w(this.TAG, 'Flv: Invalid video packet, missing VideoData payload!');
            return;
        }

        if (this._hasVideoFlagOverrided === true && this._hasVideo === false) {
            // If hasVideo: false indicated explicitly in MediaDataSource,
            // Ignore all the video packets
            return;
        }

        let spec = (new Uint8Array(arrayBuffer, dataOffset, dataSize))[0];

        let frameType = (spec & 240) >>> 4;
        let codecId = spec & 15;

        if (codecId !== 7) {
            this._onError(DemuxErrors.CODEC_UNSUPPORTED, `Flv: Unsupported codec in video frame: ${codecId}`);
            return;
        }

        // 解析AVC视频Packet
        this._parseAVCVideoPacket(arrayBuffer, dataOffset + 1, dataSize - 1, tagTimestamp, tagPosition, frameType);
    }

    /**
     * 解析AVC视频Packet
     * 
     * @param {数据缓冲区} arrayBuffer 
     * @param {数据起始位置} dataOffset 
     * @param {数据大小} dataSize 
     * @param {flv - Tag 时间戳} tagTimestamp 
     * @param {flv - tag 位置} tagPosition 
     * @param {帧类型} frameType 
     */
    _parseAVCVideoPacket(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType) {
        if (dataSize < 4) {
            Log.w(this.TAG, 'Flv: Invalid AVC packet, missing AVCPacketType or/and CompositionTime');
            return;
        }

        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        // 获取 tag的packetType
        let packetType = v.getUint8(0);
        let cts_unsigned = v.getUint32(0, !le) & 0x00FFFFFF;
        let cts = (cts_unsigned << 8) >> 8;  // convert to 24-bit signed int

        if (packetType === 0) {  // AVCDecoderConfigurationRecord
            // 解析视频的解码器配置信息
            this._parseAVCDecoderConfigurationRecord(arrayBuffer, dataOffset + 4, dataSize - 4);
        } else if (packetType === 1) {  // One or more Nalus
            // 解析一个或多个H264的Nalu
            this._parseAVCVideoData(arrayBuffer, dataOffset + 4, dataSize - 4, tagTimestamp, tagPosition, frameType, cts);
        } else if (packetType === 2) {
            // empty, AVC end of sequence
            // AVC结束序列
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Invalid video packet type ${packetType}`);
            return;
        }
    }

    /**
     * 解析AVC解码器配置信息
     * 
     * @param {数据数组缓冲区} arrayBuffer 
     * @param {数据起始位置} dataOffset 
     * @param {数据大小} dataSize 
     */
    _parseAVCDecoderConfigurationRecord(arrayBuffer, dataOffset, dataSize) {
        if (dataSize < 7) {
            Log.w(this.TAG, 'Flv: Invalid AVCDecoderConfigurationRecord, lack of data!');
            return;
        }

        let meta = this._videoMetadata;
        let track = this._videoTrack;
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (!meta) {
            if (this._hasVideo === false && this._hasVideoFlagOverrided === false) {
                this._hasVideo = true;
                this._mediaInfo.hasVideo = true;
            }

            // 初始化meta对象
            meta = this._videoMetadata = {};
            // 初始化 type
            meta.type = 'video';
            // 初始化 id
            meta.id = track.id;
            // 初始化 timescale
            meta.timescale = this._timescale;
            // 初始化 duration
            meta.duration = this._duration;
        } else {
            if (typeof meta.avcc !== 'undefined') {
                Log.w(this.TAG, 'Found another AVCDecoderConfigurationRecord!');
            }
        }

        let version = v.getUint8(0);  // configurationVersion
        let avcProfile = v.getUint8(1);  // avcProfileIndication
        let profileCompatibility = v.getUint8(2);  // profile_compatibility
        let avcLevel = v.getUint8(3);  // AVCLevelIndication

        if (version !== 1 || avcProfile === 0) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord');
            return;
        }

        this._naluLengthSize = (v.getUint8(4) & 3) + 1;  // lengthSizeMinusOne
        if (this._naluLengthSize !== 3 && this._naluLengthSize !== 4) {  // holy shit!!!
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Strange NaluLengthSizeMinusOne: ${this._naluLengthSize - 1}`);
            return;
        }

        let spsCount = v.getUint8(5) & 31;  // numOfSequenceParameterSets
        if (spsCount === 0) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord: No SPS');
            return;
        } else if (spsCount > 1) {
            Log.w(this.TAG, `Flv: Strange AVCDecoderConfigurationRecord: SPS Count = ${spsCount}`);
        }

        let offset = 6;

        for (let i = 0; i < spsCount; i++) {
            let len = v.getUint16(offset, !le);  // sequenceParameterSetLength
            offset += 2;

            if (len === 0) {
                continue;
            }

            // Notice: Nalu without startcode header (00 00 00 01)
            let sps = new Uint8Array(arrayBuffer, dataOffset + offset, len);
            offset += len;

            let config = SPSParser.parseSPS(sps);
            if (i !== 0) {
                // ignore other sps's config
                continue;
            }

            meta.codecWidth = config.codec_size.width;
            meta.codecHeight = config.codec_size.height;
            meta.presentWidth = config.present_size.width;
            meta.presentHeight = config.present_size.height;

            meta.profile = config.profile_string;
            meta.level = config.level_string;
            meta.bitDepth = config.bit_depth;
            meta.chromaFormat = config.chroma_format;
            meta.sarRatio = config.sar_ratio;
            meta.frameRate = config.frame_rate;

            if (config.frame_rate.fixed === false ||
                config.frame_rate.fps_num === 0 ||
                config.frame_rate.fps_den === 0) {
                meta.frameRate = this._referenceFrameRate;
            }

            let fps_den = meta.frameRate.fps_den;
            let fps_num = meta.frameRate.fps_num;
            meta.refSampleDuration = meta.timescale * (fps_den / fps_num);

            let codecArray = sps.subarray(1, 4);
            let codecString = 'avc1.';
            for (let j = 0; j < 3; j++) {
                let h = codecArray[j].toString(16);
                if (h.length < 2) {
                    h = '0' + h;
                }
                codecString += h;
            }
            meta.codec = codecString;

            let mi = this._mediaInfo;
            mi.width = meta.codecWidth;
            mi.height = meta.codecHeight;
            mi.fps = meta.frameRate.fps;
            mi.profile = meta.profile;
            mi.level = meta.level;
            mi.refFrames = config.ref_frames;
            mi.chromaFormat = config.chroma_format_string;
            mi.sarNum = meta.sarRatio.width;
            mi.sarDen = meta.sarRatio.height;
            mi.videoCodec = codecString;

            if (mi.hasAudio) {
                if (mi.audioCodec != null) {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                }
            } else {
                mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + '"';
            }
            if (mi.isComplete()) {
                this._onMediaInfo(mi);
            }
        }

        let ppsCount = v.getUint8(offset);  // numOfPictureParameterSets
        if (ppsCount === 0) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord: No PPS');
            return;
        } else if (ppsCount > 1) {
            Log.w(this.TAG, `Flv: Strange AVCDecoderConfigurationRecord: PPS Count = ${ppsCount}`);
        }

        offset++;

        for (let i = 0; i < ppsCount; i++) {
            let len = v.getUint16(offset, !le);  // pictureParameterSetLength
            offset += 2;

            if (len === 0) {
                continue;
            }

            // pps is useless for extracting video information
            offset += len;
        }

        meta.avcc = new Uint8Array(dataSize);
        meta.avcc.set(new Uint8Array(arrayBuffer, dataOffset, dataSize), 0);
        Log.v(this.TAG, 'Parsed AVCDecoderConfigurationRecord');

        if (this._isInitialMetadataDispatched()) {
            // flush parsed frames
            if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                this._onDataAvailable(this._audioTrack, this._videoTrack);
            }
        } else {
            this._videoInitialMetadataDispatched = true;
        }
        // notify new metadata
        this._dispatch = false;
        // 通知 muxer 视频轨道的meta数据到达
        this._onTrackMetadata('video', meta);
    }

    /**
     * 解析AVC视频数据
     * 
     * @param {数据数组缓冲区} arrayBuffer 
     * @param {数据起始位置} dataOffset 
     * @param {数据大小} dataSize 
     * @param {flv-tag时间戳} tagTimestamp 
     * @param {flv-tag位置} tagPosition 
     * @param {帧类型} frameType 
     * @param {cts} cts 
     */
    _parseAVCVideoData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, cts) {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let units = [], length = 0;

        let offset = 0;

        // 读取flv的nal长度占用的字节数
        const lengthSize = this._naluLengthSize;

        // 计算当前帧的dts时间戳
        let dts = this._timestampBase + tagTimestamp;
        // 获取关键帧标志
        let keyframe = (frameType === 1);  // from FLV Frame Type constants

        // 循环解析Nalu
        // [naluSize] [nalu] [naluSize] [nalu] ......
        while (offset < dataSize) {
            if (offset + 4 >= dataSize) {
                Log.w(this.TAG, `Malformed Nalu near timestamp ${dts}, offset = ${offset}, dataSize = ${dataSize}`);
                break;  // data not enough for next Nalu
            }
            // Nalu with length-header (AVC1)
            let naluSize = v.getUint32(offset, !le);  // Big-Endian read
            if (lengthSize === 3) {
                naluSize >>>= 8;
            }
            if (naluSize > dataSize - lengthSize) {
                Log.w(this.TAG, `Malformed Nalus near timestamp ${dts}, NaluSize > DataSize!`);
                return;
            }

            // 读取naltype
            let unitType = v.getUint8(offset + lengthSize) & 0x1F;

            if (unitType === 5) {  // IDR
                keyframe = true;
            }

            // 读取数据 data: [naluSize] + [nalu]
            let data = new Uint8Array(arrayBuffer, dataOffset + offset, lengthSize + naluSize);
            // 封装为unit
            let unit = {type: unitType, data: data};
            // 将unit对象压栈到untis中
            units.push(unit);

            // 统计字节长度
            length += data.byteLength;

            // 计算新的偏移量
            offset += lengthSize + naluSize;
        }

        // 构造sample - 每个sample为一个视频帧
        if (units.length) {
            let track = this._videoTrack;
            let avcSample = {
                units: units,
                length: length,
                isKeyframe: keyframe,
                dts: dts,
                cts: cts,
                pts: (dts + cts)
            };
            if (keyframe) {
                avcSample.fileposition = tagPosition;
            }
            track.samples.push(avcSample);
            track.length += length;
        }
    }

}

/**
 * 导出FLVDemuxer解析类
 */
export default FLVDemuxer;