package api

import (
	"net/http"

	"github.com/88250/gulu"
	noemaattributeview "github.com/aaronhe/noema/kernel/noema/attributeview"
	"github.com/gin-gonic/gin"
)

func evaluateNoemaAttributeView(c *gin.Context) {
	ret := gulu.Ret.NewResult()
	defer c.JSON(http.StatusOK, ret)

	var request noemaattributeview.Request
	if err := c.ShouldBindJSON(&request); nil != err {
		ret.Code = -1
		ret.Msg = err.Error()
		return
	}
	if nil == request.Items {
		ret.Code = -1
		ret.Msg = "items are required"
		return
	}
	ret.Data = noemaattributeview.Evaluate(request)
}
