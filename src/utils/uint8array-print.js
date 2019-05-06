/**
 * uint8Array 打印输出
 */

/**
 * 打印输出uint8数组
 * @param {打印输出uint8数组} uint8array 
 */
function uint8ArrayPrint(uint8array, offset, len) {
    let hexstr = '';
    // uint8array.forEach(element => {
    //     hexstr += '0x' + element.toString(16) + ' ';
    // });
    if (offset > len) return '';
    for (let i = offset; i < len; i++) {
        let element = uint8array[i];
        hexstr += '0x' + element.toString(16) + ' ';
    }

    return hexstr;
}

/**
 * 导出decodeUTF8函数
 */
export default uint8ArrayPrint;